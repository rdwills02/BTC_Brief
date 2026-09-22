/* channel-core.js - shared channel-detection logic.
 * Consumed identically by radar.html (browser global) and Node (require).
 * PURE detection only: no DOM, no fetch, no localStorage.
 * Extracted VERBATIM from the current live radar.html - logic unchanged, including the
 * 2026-07-03 EMA-bonus halving (5/4/2) and the per-coin diag counting.
 *
 * detectChannel accepts an OPTIONAL `diag` object. The live scanner passes its own diag
 * so funnel counters populate exactly as before. Called with no diag (backtest), a local
 * throwaway is used - the returned channel is identical either way.
 *
 * H7 (Remediation spec, 2026-09-21/22): detectChannel now also accepts an OPTIONAL third
 * `meta` argument ({coinId, timeframe, source}), used only to stamp the new fit-contract
 * fields below (fitId, timeframe, candleSource) - it changes no detection logic. Every
 * existing two-argument call site (detectChannel(candles, diag)) keeps working unchanged:
 * meta defaults to {} and the stamped fields just read as null/generic. New fields are
 * ADDITIVE on the `best` object - nothing existing is renamed or removed. NOTE the OHLC
 * provider is exposed as `candleSource`, not `source`: grepping radar.html for every current
 * best.* / r.* read (before making this change) found `source` ALREADY in use on the merged
 * row for a different concept ('grid'|'daily'|'both' - see mergeCandidateRow) that gates
 * confirmedAndQualified and badge rendering - see the field's own comment below for the full
 * collision trace. `meta.source` (the INPUT param) keeps its name; only the OUTPUT field is
 * renamed, to avoid a confusing input/output name mismatch being worse than it's worth -
 * see makeFitId/detectChannel's own param names, unchanged.
 *
 * SCOPE NOTE: this only satisfies H7's "fit" half. H7's "candle" half (venue, pair, quote
 * currency, provider timestamp+meaning, isClosed, fetchedAt, raw record beside normalized)
 * is deliberately NOT added here - `candles` arriving here are already the app's own light
 * {time,open,high,low,close,date} shape; the full candle contract belongs where candles are
 * actually stored (data/cache/<cgId>.json, in cache-core.js/capture.js), which radar.html's
 * live scan never reads. See the H7/H8 handoff for the scope split and the BACKLOG item this
 * leaves (a full contract-shaped candle is never round-tripped through the live 4-day grid
 * path; only the flat shape is).
 */

// --- Detection constants ---
var PIVOT_LB = 3;
var TOUCH_TOL = 0.025;
// Indicator Upgrades Group 1 (2026-09-20): tolerance for "closes at or near the bar's high"
// in rocketAtSupport - expressed as a fraction of the bar's own high-low range, not a price
// tolerance like TOUCH_TOL (which is always relative to a rail level). 0.25 means the close
// sits within the top quarter of the bar's range. Judgment call, not backtested - flagged in
// the batch write-up for Ryan to tune if population validation says otherwise.
var ROCKET_CLOSE_TOL = 0.25;

// H7 fit-contract constants (Remediation spec, 2026-09-21/22).
var FIT_SCHEMA_VERSION = 1;
var DETECTOR_VERSION = 'channel-core-h7-2026-09-22';
// Window (in candles) used for containmentRecent, alongside the existing full-window
// `containment`. PROVISIONAL - not backtested or population-validated; chosen only to be
// short enough to reflect "is the rail holding right now" distinctly from the full-fit
// containment. Flagged as BACKLOG in the H7/H8 handoff for calibration against accumulated
// post-mortem data, same as ROCKET_CLOSE_TOL above.
var CONTAINMENT_RECENT_WINDOW = 20;

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

// Indicator Upgrades Group 1 (2026-09-20): bb3Reversion/bullEngulfing/threeInsideUp now return
// {hit:bool, idx:number|null, time:number|null} instead of a bare boolean, so the chart-overlay
// toggle (item 6) has a candle to point a marker at. idx is the position within the `candles`
// array passed in (same convention detectChannel/findPivots already use for rail-fit indices -
// railAt(slope,intercept,idx) expects this same idx space). time is candles[idx].time, or null
// when hit is false. Every existing caller reads the truthy/falsy row-level boolean fields
// (r.bb3/r.bullEngulf/r.threeInsideUp on the row object built in detectChannel below) - those
// stay plain booleans (see `best = {...}` below: bb3:conf.bb3.hit, not conf.bb3). Only this
// function's OWN return shape changes; nothing that reads the row fields needs to change.
function bb3Reversion(candles) {
  // Pushed below the lower 3-std Bollinger Band in the last ~5 bars, now retraced back inside.
  var n = candles.length; if(n < 21) return {hit:false, idx:null, time:null};
  function lowerAt(i) {
    var sum=0; for(var j=i-19;j<=i;j++) sum+=candles[j].close;
    var mean=sum/20, v=0;
    for(var j=i-19;j<=i;j++){ var d=candles[j].close-mean; v+=d*d; }
    return mean - 3*Math.sqrt(v/20);
  }
  var cur=n-1;
  if(candles[cur].close < lowerAt(cur)) return {hit:false, idx:null, time:null}; // still below band, not retraced yet
  var start=Math.max(20, cur-4);
  // Trigger candle = the most recent bar (closest to `cur`) whose low actually pierced the
  // band - that's the bar a chart marker should point at, not `cur` itself (which is just
  // where the retrace happens to be confirmed). Loop runs newest-to-oldest so the first hit
  // found is the most recent dip.
  for(var i=cur;i>=start;i--){
    if(candles[i].low < lowerAt(i)) return {hit:true, idx:i, time:candles[i].time};
  }
  return {hit:false, idx:null, time:null};
}
function bullEngulfing(candles) {
  var n=candles.length; if(n<2) return {hit:false, idx:null, time:null};
  var a=candles[n-2], b=candles[n-1];
  var hit = (a.close<a.open) && (b.close>b.open) && (b.close>=a.open) && (b.open<=a.close);
  return hit ? {hit:true, idx:n-1, time:b.time} : {hit:false, idx:null, time:null};
}
function threeInsideUp(candles) {
  var n=candles.length; if(n<3) return {hit:false, idx:null, time:null};
  var c1=candles[n-3], c2=candles[n-2], c3=candles[n-1];
  var c1Bear = c1.close<c1.open;
  var c2Bull = c2.close>c2.open;
  var c2Inside = Math.max(c2.open,c2.close)<=c1.open && Math.min(c2.open,c2.close)>=c1.close;
  var c3Up = c3.close>c2.close;
  var hit = c1Bear && c2Bull && c2Inside && c3Up;
  return hit ? {hit:true, idx:n-1, time:c3.time} : {hit:false, idx:null, time:null};
}

// Indicator Upgrades Group 2 (2026-09-20): bearish exit-warning mirror of bb3Reversion, band
// inverted. Same 20-bar window, same 3-std-dev multiplier, same "last ~5 bars" trigger-search
// window as bb3Reversion - sign-flipped, not re-derived. Display-only exit-warning flag on an
// existing long (see Radar Indicator Upgrades.md's "Correction - bearish detection isn't gated
// on execution"), not part of any independent bearish/short-channel detector (that stays
// deferred to the future paper-trade project - not touched here).
function bb3UpperReversion(candles) {
  // Pushed above the upper 3-std Bollinger Band in the last ~5 bars, now retraced back inside.
  var n = candles.length; if(n < 21) return {hit:false, idx:null, time:null};
  function upperAt(i) {
    var sum=0; for(var j=i-19;j<=i;j++) sum+=candles[j].close;
    var mean=sum/20, v=0;
    for(var j=i-19;j<=i;j++){ var d=candles[j].close-mean; v+=d*d; }
    return mean + 3*Math.sqrt(v/20);
  }
  var cur=n-1;
  if(candles[cur].close > upperAt(cur)) return {hit:false, idx:null, time:null}; // still above band, not retraced yet
  var start=Math.max(20, cur-4);
  // Trigger candle = the most recent bar (closest to `cur`) whose high actually pierced the
  // band - same "most recent dip" convention as bb3Reversion's own loop, mirrored to the upper
  // side. Loop runs newest-to-oldest so the first hit found is the most recent push.
  for(var i=cur;i>=start;i--){
    if(candles[i].high > upperAt(i)) return {hit:true, idx:i, time:candles[i].time};
  }
  return {hit:false, idx:null, time:null};
}
// Indicator Upgrades Group 2 (2026-09-20): bearish exit-warning mirror of threeInsideUp,
// inverted. c1 bullish, c2 bearish and inside c1's body, c3 closes LOWER than c2's close.
function threeInsideDown(candles) {
  var n=candles.length; if(n<3) return {hit:false, idx:null, time:null};
  var c1=candles[n-3], c2=candles[n-2], c3=candles[n-1];
  var c1Bull = c1.close>c1.open;
  var c2Bear = c2.close<c2.open;
  var c2Inside = Math.max(c2.open,c2.close)<=c1.close && Math.min(c2.open,c2.close)>=c1.open;
  var c3Down = c3.close<c2.close;
  var hit = c1Bull && c2Bear && c2Inside && c3Down;
  return hit ? {hit:true, idx:n-1, time:c3.time} : {hit:false, idx:null, time:null};
}

// Indicator Upgrades Group 1 (2026-09-20): new pattern function. "Rocket at support" per
// Brett's checklist (Radar Indicator Upgrades.md): green candle, real body resting at/near
// the fitted support rail, a lower wick below the body, closes at or near the bar's high.
// Only meaningful once a channel has been fitted (needs a rail to be "at/near"), so unlike
// bb3Reversion/bullEngulfing/threeInsideUp (pure candle-history signals, computed once per
// coin before the rail-pair loop) this is computed AFTER `best` is chosen in detectChannel,
// against best's own supSlope/supIntercept - see the call site below. Same style as the
// existing pattern functions: checks only the latest candle (idx = n-1), same TOUCH_TOL
// convention as the rest of this file for "near".
function rocketAtSupport(candles, supSlope, supIntercept) {
  var n = candles.length; if(n < 1) return {hit:false, idx:null, time:null};
  var i = n-1, c = candles[i];
  if(!(c.close > c.open)) return {hit:false, idx:null, time:null}; // must be a green candle
  var range = c.high - c.low;
  if(range <= 0) return {hit:false, idx:null, time:null};
  var bodyLow = Math.min(c.open, c.close);
  var railVal = railAt(supSlope, supIntercept, i);
  if(!(railVal > 0)) return {hit:false, idx:null, time:null};
  var nearRail = Math.abs(bodyLow - railVal) / railVal <= TOUCH_TOL;
  var hasLowerWick = c.low < bodyLow;
  var closesNearHigh = (c.high - c.close) <= ROCKET_CLOSE_TOL * range;
  var hit = nearRail && hasLowerWick && closesNearHigh;
  return hit ? {hit:true, idx:i, time:c.time} : {hit:false, idx:null, time:null};
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

// H7 (Remediation spec, 2026-09-21/22): deterministic fitId - plain string concat, no crypto
// (must run identically in the browser and Node). Same inputs -> same id; a re-fit of the
// same coin/timeframe/source ending at the same candle with the same window produces the
// same id, so callers can dedupe/compare fits across runs. coinId/timeframe/source come from
// the OPTIONAL `meta` a caller passes to detectChannel (see header note) - a caller that
// doesn't pass meta gets 'unknown' in those slots, which still makes a valid (if less
// specific) id rather than throwing.
function makeFitId(coinId, timeframe, source, fitEndTime, firstIdx, lastIdx) {
  return [coinId || 'unknown', timeframe || 'unknown', source || 'unknown',
    firstIdx, lastIdx, fitEndTime].join('|');
}

// H7: containment over just the last CONTAINMENT_RECENT_WINDOW candles of the fit window,
// alongside the existing full-window `containment` (renamed on the output object to
// containmentFull, value unchanged - see detectChannel below). Same inside/outside test as
// the full-window loop (TOUCH_TOL-widened rail band), restricted to the most recent bars.
// Returns null (not 0) when the fit window itself is shorter than the recent window - a
// short fit isn't "0% contained recently", it's "recent containment isn't a meaningful
// number yet"; callers must not treat null as a failing score.
function computeRecentContainment(candles, slope, intercept, channelH, firstIdx, lastIdx) {
  var winStart = lastIdx - CONTAINMENT_RECENT_WINDOW + 1;
  if(winStart < firstIdx) return null;
  var inside = 0, total = 0;
  for(var ci = winStart; ci <= lastIdx; ci++) {
    var s = railAt(slope, intercept, ci);
    var r = s + channelH;
    var c = candles[ci];
    if(c.low >= s*(1-TOUCH_TOL) && c.high <= r*(1+TOUCH_TOL)) inside++;
    total++;
  }
  return Math.round((inside/total)*100);
}

// Indicator Upgrades Group 1 (2026-09-20): "multiple signals on one candle" meta-flag - true
// when 2+ of {bb3, bullEngulf, threeInsideUp, rocket} are true AND their trigger candles are
// the same or adjacent (|idx delta| <= 1). bullEngulfing/threeInsideUp/rocket always trigger
// at idx=n-1 when true, so they trivially coincide with each other; bb3Reversion's trigger can
// be up to 4 bars earlier (the actual band-piercing dip), which is why the adjacency check
// (not strict equality) matters - it's the one signal that can legitimately miss by a bar or
// two while still being "the same setup".
function multiSignalOnOneCandle(triggers) {
  // triggers: array of {hit, idx, time} in the shape bb3Reversion/bullEngulfing/threeInsideUp/
  // rocketAtSupport return.
  var hits = triggers.filter(function(t){ return t && t.hit && t.idx != null; });
  if(hits.length < 2) return {hit:false, idx:null, time:null};
  for(var a=0; a<hits.length-1; a++) {
    for(var b=a+1; b<hits.length; b++) {
      if(Math.abs(hits[a].idx - hits[b].idx) <= 1) {
        // Report at the more recent of the coinciding pair.
        var newer = hits[a].idx >= hits[b].idx ? hits[a] : hits[b];
        return {hit:true, idx:newer.idx, time:newer.time};
      }
    }
  }
  return {hit:false, idx:null, time:null};
}

// --- Channel detection (scoring + per-coin diag) ---
// H7: OPTIONAL third arg `meta` ({coinId, timeframe, source}) - see header note. Every
// existing 2-arg caller is unaffected (meta defaults to {}).
function detectChannel(candles, diag, meta) {
  if(!diag) diag = {universe:0,volExcluded:0,catExcluded:0,ohlcOk:0,railPairs:0,posSlope:0,touches:0,containment:0,scoreOk:0,candidates:0};
  if(!meta) meta = {};
  if(!candles || candles.length < 30) return null;
  var p = findPivots(candles);
  var highs = p.highs, lows = p.lows;
  if(lows.length < 3 || highs.length < 1) return null;
  var n = candles.length;
  var best = null;

  // Confluence signals are properties of the coin (not the rail pair): compute once.
  var ema = emaState(candles);
  var conf = {bb3:bb3Reversion(candles), bullEngulf:bullEngulfing(candles), threeInsideUp:threeInsideUp(candles),
    bb3UpperReversion:bb3UpperReversion(candles), threeInsideDown:threeInsideDown(candles)};

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
        return exp > 0 && Math.abs(l.price-exp)/exp <= TOUCH_TOL;
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
        return exp > 0 && Math.abs(h.price-exp)/exp <= TOUCH_TOL;
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
      // Group 5 item 6 (2026-09-21), OPTION A per Ryan's explicit direction (2026-09-21):
      // n counts only bb3/bullEngulf/threeInsideUp, the three pass-level pattern signals
      // already known at this point in the loop. rocket is deliberately excluded - it isn't
      // computed until AFTER `best` is chosen (rocketAtSupport() runs once, post-loop, against
      // the WINNING rail only - see the `if(best)` block below), so it structurally cannot
      // feed a per-candidate-pair bonus computed here. Feeding rocket into score is a distinct,
      // not-yet-approved ask - filed separately as its own backlog item, not built here.
      var patternN = (conf.bb3.hit?1:0) + (conf.bullEngulf.hit?1:0) + (conf.threeInsideUp.hit?1:0);
      var patternBonus = patternN > 0 ? (2*patternN - 1) : 0;
      score += patternBonus;
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
          // Indicator Upgrades Group 1: row-level fields stay plain booleans (backward-compat
          // with confluenceList()/toLightCandidate()/adaptCaptureCoin()/adaptDailyCoin() in
          // radar.html, which all read r.bb3/r.bullEngulf/r.threeInsideUp as truthy checks) -
          // only conf.bb3/conf.bullEngulf/conf.threeInsideUp (this function's internal locals)
          // are now {hit,idx,time} objects. Trigger data goes on separate *Trigger fields.
          bb3:conf.bb3.hit, bullEngulf:conf.bullEngulf.hit, threeInsideUp:conf.threeInsideUp.hit,
          bb3Trigger:conf.bb3, bullEngulfTrigger:conf.bullEngulf, threeInsideUpTrigger:conf.threeInsideUp,
          // Indicator Upgrades Group 2 (2026-09-20): bearish exit-warning mirrors. Display-only,
          // same row-level boolean + separate *Trigger convention as the bull-side flags above.
          // Not fed into score/getBucket/buildAction - see the batch's hard constraint.
          bb3UpperReversion:conf.bb3UpperReversion.hit, threeInsideDown:conf.threeInsideDown.hit,
          bb3UpperReversionTrigger:conf.bb3UpperReversion, threeInsideDownTrigger:conf.threeInsideDown,

          // --- H7 fit-contract fields (Remediation spec, 2026-09-21/22) — additive only. ---
          fitId: makeFitId(meta.coinId, meta.timeframe, meta.source, candles[lastIdx].time, firstIdx, lastIdx),
          timeframe: meta.timeframe || null,
          // NOTE: exposed as `candleSource`, not `source` — radar.html already has a
          // display-critical `source` field on the merged row meaning 'grid'|'daily'|'both'
          // (gates confirmedAndQualified/badge rendering; see mergeCandidateRow). A field
          // named `source` here would collide with that key the moment this object flows
          // through the merge's generic `for(k in base) merged[k]=base[k]` spread — reassigned
          // back to the correct value two lines later in mergeCandidateRow today, but a
          // needless landmine for the next reader/change. `candleSource` (the OHLC provider:
          // 'coingecko'|'kraken'|'coinbase') is a distinct concept from that display field and
          // gets its own name.
          candleSource: meta.source || null,
          lookback: candles.length,
          fitStartTime: candles[firstIdx].time,
          fitEndTime: candles[lastIdx].time,
          schemaVersion: FIT_SCHEMA_VERSION,
          detectorVersion: DETECTOR_VERSION,
          // containmentFull is the SAME number as `containment` above (full-fit-window,
          // rounded) under the spec's own name; `containment` itself is left untouched
          // because radar.html gates on it directly (r.containment < t.minContain).
          containmentFull: Math.round(containment),
          containmentRecent: computeRecentContainment(candles, slope, intercept, channelH, firstIdx, lastIdx),
          touchEvents: supTouches,
          pivotIds: supTouches.map(function(t){ return t.time; }),
          nearestResistance: resNow,
          detectionPrice: curPrice,
          detectionAsOf: candles[lastIdx].time,
          // Placeholder only — H9 (lifecycle states: intact/wick-probed/broken/
          // reclaimed-awaiting-retest/re-qualified) is explicitly out of scope for this step
          // (deferred to work-order Step 6). This is the narrowest honest placeholder: a
          // single-close-below-invalidation flag, not a real lifecycle state machine. Filed
          // as BACKLOG in the H7/H8 handoff — do not treat this as H9 done.
          lifecycleState: curPrice < invalidation ? 'single-close-below-invalidation' : 'active',
          // Placeholder only — H5 (freeze issued signals / breach-history population) is
          // explicitly out of scope for this step (deferred to Step 11). Always empty here;
          // filed as BACKLOG in the H7/H8 handoff.
          breachHistory: []
        };
      }
    }
  }

  // Count this coin exactly once into each stage it reached, based on the flags above.
  if(hadRailPair) diag.railPairs++;
  if(hadPosSlope) diag.posSlope++;
  if(had3Touches) diag.touches++;
  if(hadContainment) diag.containment++;

  // Indicator Upgrades Group 1 (2026-09-20): Rocket-at-support and the multi-signal meta-flag
  // both need the WINNING channel's rail (rocket) or the other three flags' trigger data
  // (multi-signal), so they're computed once here against `best`, not inside the rail-pair
  // loop above (unlike bb3/bullEngulf/threeInsideUp, which are pure candle signals independent
  // of any rail and are computed once per coin, before the loop, same as before this batch).
  if(best) {
    var rocket = rocketAtSupport(candles, best.supSlope, best.supIntercept);
    // Analysis-thread review (2026-09-20), item 2 fix: for COINCIDENCE purposes bb3's trigger
    // candle is the current/retrace bar (n-1) - the bar bb3's own pill is actually true on
    // ("closed back inside it") - not the earlier dip bar. bb3Trigger (stored on `best` below,
    // unchanged) keeps the dip-bar idx/time for the chart marker in item 6; this is a second,
    // separate read off the same underlying signal used only to decide coincidence here.
    var bb3Coincidence = conf.bb3.hit ? {hit:true, idx:n-1, time:candles[n-1].time} : conf.bb3;
    var multi = multiSignalOnOneCandle([bb3Coincidence, conf.bullEngulf, conf.threeInsideUp, rocket]);
    best.rocket = rocket.hit;
    best.rocketTrigger = rocket;
    best.multiSignal = multi.hit;
    best.multiSignalTrigger = multi;
  }

  return best;
}

// Node export (browser ignores this; functions stay globals in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PIVOT_LB: PIVOT_LB, TOUCH_TOL: TOUCH_TOL, ROCKET_CLOSE_TOL: ROCKET_CLOSE_TOL,
    FIT_SCHEMA_VERSION: FIT_SCHEMA_VERSION, DETECTOR_VERSION: DETECTOR_VERSION,
    CONTAINMENT_RECENT_WINDOW: CONTAINMENT_RECENT_WINDOW,
    clamp: clamp, emaLast: emaLast, emaState: emaState,
    bb3Reversion: bb3Reversion, bullEngulfing: bullEngulfing, threeInsideUp: threeInsideUp,
    bb3UpperReversion: bb3UpperReversion, threeInsideDown: threeInsideDown,
    rocketAtSupport: rocketAtSupport, multiSignalOnOneCandle: multiSignalOnOneCandle,
    findPivots: findPivots, railAt: railAt, makeFitId: makeFitId,
    computeRecentContainment: computeRecentContainment, detectChannel: detectChannel
  };
}
