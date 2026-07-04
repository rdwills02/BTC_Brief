/* channel-core.js - shared channel-detection logic.
 * Consumed identically by radar.html (browser global) and Node (require).
 * PURE detection only: no DOM, no fetch, no localStorage.
 * Extracted VERBATIM from the current live radar.html - logic unchanged, including the
 * 2026-07-03 EMA-bonus halving (5/4/2) and the per-coin diag counting.
 *
 * detectChannel accepts an OPTIONAL `diag` object. The live scanner passes its own diag
 * so funnel counters populate exactly as before. Called with no diag (backtest), a local
 * throwaway is used - the returned channel is identical either way.
 */

// --- Detection constants ---
var PIVOT_LB = 3;
var TOUCH_TOL = 0.025;

// --- Small pure util ---

function clamp(v,a,b) { return Math.max(a,Math.min(b,v)); }

// --- Confluence signals (from daily OHLC) ---
function emaLast(vals, period) {
  if(!vals.length) return null;
  var k = 2/(period+1), e = vals[0];
  for(var i=1;i<vals.length;i++) e = vals[i]*k + e*(1-k);
  return e;
}
function emaState(candles) {
  var closes = candles.map(function(c){return c.close;});
  var last = closes[closes.length-1];
  var e21 = emaLast(closes,21), e50 = emaLast(closes,50);
  var state, pts;
  // EMA bonus halved 2026-07-03: live verify run showed 15/34 candidates (44%) landing
  // in High+Probable buckets, most of them 'above_both'. Original 10/8/5 pts was tuned
  // before this bonus existed and was inflating too many coins across bucket boundaries.
  // NOTE: Brett's checklist criterion "price above 21/50 EMA" specifies +10/+8/+5 - this
  // 5/4/2 halving is a DELIBERATE, Ryan-approved deviation from that spec (2026-07-03),
  // made specifically to fix the bucket inflation. Do not "correct" this back to 10/8/5
  // without re-checking bucket distribution on a larger sample first.
  if(last>e50 && last>e21) { state='above_both'; pts=(e21>=e50)?5:4; }
  else if(last>e50)        { state='above_50';   pts=2; }
  else                     { state='below';      pts=0; }
  return {state:state, pts:pts, e21:e21, e50:e50};
}
function bb3Reversion(candles) {
  // Pushed below the lower 3-std Bollinger Band in the last ~5 bars, now retraced back inside.
  var n = candles.length; if(n < 21) return false;
  function lowerAt(i) {
    var sum=0; for(var j=i-19;j<=i;j++) sum+=candles[j].close;
    var mean=sum/20, v=0;
    for(var j=i-19;j<=i;j++){ var d=candles[j].close-mean; v+=d*d; }
    return mean - 3*Math.sqrt(v/20);
  }
  var cur=n-1;
  if(candles[cur].close < lowerAt(cur)) return false; // still below band, not retraced yet
  var start=Math.max(20, cur-4);
  for(var i=cur;i>=start;i--){ if(candles[i].low < lowerAt(i)) return true; }
  return false;
}
function bullEngulfing(candles) {
  var n=candles.length; if(n<2) return false;
  var a=candles[n-2], b=candles[n-1];
  return (a.close<a.open) && (b.close>b.open) && (b.close>=a.open) && (b.open<=a.close);
}
function threeInsideUp(candles) {
  var n=candles.length; if(n<3) return false;
  var c1=candles[n-3], c2=candles[n-2], c3=candles[n-1];
  var c1Bear = c1.close<c1.open;
  var c2Bull = c2.close>c2.open;
  var c2Inside = Math.max(c2.open,c2.close)<=c1.open && Math.min(c2.open,c2.close)>=c1.close;
  var c3Up = c3.close>c2.close;
  return c1Bear && c2Bull && c2Inside && c3Up;
}

// --- Pivots + rails ---
function findPivots(candles) {
  var highs=[], lows=[];
  for(var i=PIVOT_LB; i<candles.length-PIVOT_LB; i++) {
    var isH=true, isL=true;
    for(var j=i-PIVOT_LB; j<=i+PIVOT_LB; j++) {
      if(j===i) continue;
      if(candles[j].high >= candles[i].high) isH=false;
      if(candles[j].low <= candles[i].low) isL=false;
    }
    if(isH) highs.push({idx:i,price:candles[i].high,time:candles[i].time});
    if(isL) lows.push({idx:i,price:candles[i].low,time:candles[i].time});
  }
  return {highs:highs, lows:lows};
}


function railAt(slope, intercept, idx) { return slope*idx+intercept; }

// --- Channel detection (scoring + per-coin diag) ---
function detectChannel(candles, diag) {
  if(!diag) diag = {universe:0,volExcluded:0,catExcluded:0,ohlcOk:0,railPairs:0,posSlope:0,touches:0,containment:0,scoreOk:0,candidates:0};
  if(!candles || candles.length < 30) return null;
  var p = findPivots(candles);
  var highs = p.highs, lows = p.lows;
  if(lows.length < 3 || highs.length < 1) return null;
  var n = candles.length;
  var best = null;

  // Confluence signals are properties of the coin (not the rail pair): compute once.
  var ema = emaState(candles);
  var conf = {bb3:bb3Reversion(candles), bullEngulf:bullEngulfing(candles), threeInsideUp:threeInsideUp(candles)};

  // Per-coin flags, not per-rail-pair counts. detectChannel() tests every pair of low
  // pivots as a candidate rail - a single coin can produce dozens of pair-evaluations,
  // so counting every pair (as this used to) inflates these numbers far past the coin
  // count and makes them meaningless as a funnel. Each flag flips true the first time
  // ANY pair for THIS coin reaches that stage, and is counted into diag exactly once
  // (see bottom of this function) - directly comparable to Universe/OHLC Loaded/Candidates.
  var hadRailPair=false, hadPosSlope=false, had3Touches=false, hadContainment=false;

  for(var a=0; a<lows.length-1; a++) {
    for(var b=a+1; b<lows.length; b++) {
      var p1=lows[a], p2=lows[b];
      var idxDelta = p2.idx - p1.idx;
      if(idxDelta < 3) continue;
      hadRailPair = true;

      var slope = (p2.price - p1.price) / idxDelta;
      if(slope < -0.05 * p1.price / idxDelta) continue;
      if(slope >= 0) hadPosSlope = true;

      var intercept = p1.price - slope * p1.idx;

      var supTouches = lows.filter(function(l) {
        var exp = railAt(slope,intercept,l.idx);
        return Math.abs(l.price-exp)/exp <= TOUCH_TOL;
      });
      if(supTouches.length < 3) continue;
      had3Touches = true;

      var firstIdx = Math.min.apply(null, supTouches.map(function(l){return l.idx;}));
      var lastIdx = n-1;
      var relHighs = highs.filter(function(h){return h.idx>=firstIdx;});
      if(!relHighs.length) continue;

      var offsets = relHighs.map(function(h){return h.price-railAt(slope,intercept,h.idx);}).filter(function(o){return o>0;});
      offsets.sort(function(a,b){return a-b;});
      if(!offsets.length) continue;
      var channelH = offsets[Math.floor(offsets.length/2)];
      if(channelH <= 0) continue;

      var resTouches = relHighs.filter(function(h) {
        var exp = railAt(slope,intercept,h.idx)+channelH;
        return Math.abs(h.price-exp)/exp <= TOUCH_TOL;
      });

      var supNow = railAt(slope,intercept,lastIdx);
      var resNow = supNow + channelH;
      var curPrice = candles[lastIdx].close;
      var position = clamp((curPrice-supNow)/channelH, 0, 1);

      var winCandles = candles.slice(firstIdx);
      var inside = 0;
      for(var i=0; i<winCandles.length; i++) {
        var ci = firstIdx+i;
        var s = railAt(slope,intercept,ci);
        var r = s+channelH;
        if(winCandles[i].low >= s*(1-TOUCH_TOL) && winCandles[i].high <= r*(1+TOUCH_TOL)) inside++;
      }
      var containment = (inside/winCandles.length)*100;
      if(containment < 55) continue;
      hadContainment = true;

      if(position > 0.75) continue;

      var slopePct = (slope / Math.abs(railAt(slope,intercept,firstIdx)||1)) * 100;
      var invalidation = supNow * (1-TOUCH_TOL);

      var score = 0;
      score += Math.min(25, supTouches.length*8);
      score += Math.min(15, resTouches.length*6);
      score += (containment/100)*20;
      var sa = Math.abs(slopePct);
      if(slope >= 0) { score += sa>=0.05&&sa<=3?15:sa<0.05?8:Math.max(0,15-(sa-3)*3); }
      else { score += Math.max(0, 8-(sa*3)); }
      score += position<=0.33?10:position<=0.5?6:position<=0.66?3:0;
      score += Math.min(6, winCandles.length/20);
      if(sa > 5) score -= 10;
      if(slope < 0) score -= 5;
      score += ema.pts; // EMA 21/50 confluence: +10/+8 above both, +5 above 50 only, 0 below
      score = Math.round(clamp(score,0,100));
      // NOTE: no per-coin "scored" counter here - a coin only reaches this line at all
      // if some pair passed every gate through position, which is exactly the condition
      // for `best` to get set below. A per-coin "scored" count would be mathematically
      // identical to Candidates (diag.candidates, incremented in scanCoin) every time -
      // pure duplication, so it's intentionally not tracked separately.

      if(!best || score > best.score) {
        best = {
          score:score, supportTouches:supTouches.length, resTouches:resTouches.length,
          containment:Math.round(containment), slope:slopePct, position:position,
          supportNow:supNow, resistNow:resNow, invalidation:invalidation, channelH:channelH,
          candles:candles.slice(-150), pivotLows:supTouches,
          supSlope:slope, supIntercept:intercept, firstIdx:firstIdx, lastIdx:lastIdx,
          isAscending:slope>=0, isFlat:Math.abs(slopePct)<0.1,
          emaState:ema.state, ema21:ema.e21, ema50:ema.e50, emaPts:ema.pts,
          bb3:conf.bb3, bullEngulf:conf.bullEngulf, threeInsideUp:conf.threeInsideUp
        };
      }
    }
  }

  // Count this coin exactly once into each stage it reached, based on the flags above.
  if(hadRailPair) diag.railPairs++;
  if(hadPosSlope) diag.posSlope++;
  if(had3Touches) diag.touches++;
  if(hadContainment) diag.containment++;

  return best;
}

// Node export (browser ignores this; functions stay globals in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIVOT_LB: PIVOT_LB, TOUCH_TOL: TOUCH_TOL,
    clamp: clamp, emaLast: emaLast, emaState: emaState,
    bb3Reversion: bb3Reversion, bullEngulfing: bullEngulfing, threeInsideUp: threeInsideUp,
    findPivots: findPivots, railAt: railAt, detectChannel: detectChannel
  };
}

