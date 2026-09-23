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

// Step 6 (Remediation spec, 2026-09-21/22; REVISED per Step 6 plan review 2026-09-22, R1-R5):
// research-mode constants. These are used ONLY by the research pair-selection path
// (detectChannelResearch, meta.research===true) - the flag-off detectChannel body above is
// unmodified source, so none of these constants can affect it. Per R3, there is no
// RESEARCH_MODE global - detectChannel(candles, diag, meta) takes meta.research as a PER-CALL
// flag, not a process-level switch.
var FIT_WINDOW = 150;         // 1d bars (A2)
var FIT_WINDOW_GRID = 40;     // 4d bars (A2)
var BREAK_RUN_MAX = 3;        // consecutive closes through invalidation -> broken (A1)
var RECLAIM_BARS = 10;        // bars since last break before a reclaim can be considered (A1/H9). PROVISIONAL, spec-given.
var MIN_ANCHOR_SPAN = 20;     // 1d bars, oldest/newest support touch spacing (A5)
var MIN_ANCHOR_SPAN_GRID = 5; // 4d bars (= 20 days-equivalent, per Step 6 plan review decision - NOT 20 raw grid bars). PROVISIONAL.
var MIN_TOUCH_GAP = 3;        // bars a middle touch must sit from either anchor (A5). PROVISIONAL.
// A3: tol = clamp(TOUCH_TOL_ATR_MULT*ATR14/price, TOUCH_TOL_MIN, TOUCH_TOL_MAX). PROVISIONAL.
// Step 6 build-restage review (2026-09-22, population finding): SATURATES on the 4d-grid
// timeframe - measured tol mean 3.97% against a 4% cap (effectively flat 4%, i.e. looser than
// the old flat 2.5% for almost every grid rail). ATR14 of 4-day bars runs ~2x a daily ATR, and
// 0.5/1%/4% were written for daily bars ("a 1%-a-day coin") - the per-timeframe multiplier is
// UNVALIDATED for 4d. Candidate fix (step 10/13, NOT applied here): a grid-specific multiplier
// (~0.25, i.e. scaled by sqrt(4)) - a tuning decision for the harness, not this step.
var TOUCH_TOL_ATR_MULT = 0.5;
var TOUCH_TOL_MIN = 0.01;     // PROVISIONAL.
var TOUCH_TOL_MAX = 0.04;     // PROVISIONAL.
// Step 7 (Remediation spec, 2026-09-21/22; per Step 7 plan review 2026-09-22, R1-R2): B1/B2
// research-mode constants. Same per-call dispatch as the Step 6 block above - only
// detectChannelResearch reads these.
var NEAR_FLAT_SLOPE_PCT = 0.1;      // B1/R2: reuses the exact value `isFlat` already uses below - not a new threshold.
var WEDGE_LOOKAHEAD = 60;           // 1d bars, B1: reject a pair whose rails cross within this many bars past lastIdx. PROVISIONAL.
var WEDGE_LOOKAHEAD_GRID = 15;      // 4d bars (= 60 days-equivalent, same day-equivalent convention as MIN_ANCHOR_SPAN_GRID). PROVISIONAL.
var RES_RECENT_BARS = 60;           // 1d bars, B2: parallel-fallback height uses only pivot highs from this many recent bars. PROVISIONAL.
var RES_RECENT_BARS_GRID = 15;      // 4d bars (day-equivalent; a raw 60 would make B2 a no-op on the 40-bar grid window). PROVISIONAL.
// B5: distToRailPct <= Math.min(2*tol, 0.06) gate lives in radar.html's buildAction, not here -
// this file only computes the field. With A3 daily tol floored at 1%, the gate is 2% on daily;
// on grid tol saturates at 4% (Step 6 A3 finding), so the gate is 6% there. Superseded later by
// the ATR rule in H6 - not applied here.

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
// E3 (Remediation spec, 2026-09-21/22; restage 2026-09-23): research-only sibling to
// bullEngulfing() above - flag-off untouched, unchanged, still called only from detectChannel.
// Called only from detectChannelResearch. Same base shape (a=candles[n-2] bearish,
// b=candles[n-1] bullish) tightened per spec: a real-body-size floor relative to volatility
// (ATR14, reused from the caller - no new ATR computation here) AND relative to the prior
// candle's own body (not just "engulfs" by price alone), and a prior-3-net-down context bar.
// Literal reading, per the Build Prompt's ambiguity rule: "the close three bars before the
// pattern's own first candle is higher than the close one bar before it" -
// candles[n-4].close > candles[n-2].close. The alternate reading (net-down over a's own 3
// predecessors) is filed as BACKLOG, not guessed further here.
//
// Close/open crossing - ANALYSIS-THREAD DECISION, restage 2026-09-23, on a population basis,
// not a spec quote: the first build made BOTH sides of the crossing strict (b.close > a.open
// AND b.open < a.close), which on the real fixture population (12 research-mode bullEngulf
// rows, full historical grid-date slice) flipped all 12 true->false, 11 of them attributed to
// strictness alone rather than the new size floors - i.e. the strict open-side test was doing
// nearly all of the "tightening" by itself, on exact-equality bars this population actually
// has, not a handful of edge cases. b.close > a.open stays strict (that side wasn't the
// documented population driver). b.open <= a.close is relaxed back to the base function's own
// non-strict test - a bar where the new candle's open lands exactly on the prior candle's
// close still counts as engulfing here, same as it always has in bullEngulfing().
var ENGULF_BODY_ATR_MULT = 0.5; // PROVISIONAL, spec E3: body >= this * ATR14.
var ENGULF_BODY_RATIO = 1.2;    // PROVISIONAL, spec E3: body >= this * the prior candle's own body.
function bullEngulfingResearch(candles, atr) {
  var n = candles.length;
  if (n < 4) return {hit:false, idx:null, time:null};
  var a = candles[n-2], b = candles[n-1];
  var bodyB = b.close - b.open;
  var bodyA = Math.abs(a.close - a.open);
  var sizeOk = (atr != null) && (bodyB >= ENGULF_BODY_ATR_MULT * atr) && (bodyB >= ENGULF_BODY_RATIO * bodyA);
  var crossOk = (a.close < a.open) && (b.close > b.open) && (b.close > a.open) && (b.open <= a.close);
  var priorDownOk = candles[n-4].close > candles[n-2].close;
  var hit = sizeOk && crossOk && priorDownOk;
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

// --- Step 6 research-mode helpers (Remediation spec, 2026-09-21/22; REVISED per Step 6 plan
// review 2026-09-22) --- used ONLY by detectChannelResearch below. None of these are called
// from the flag-off detectChannel body.

// A3: Wilder-smoothed ATR(14) on CLOSED bars. Standard Wilder recurrence (seed = simple
// average of the first 14 true ranges, then smoothed) - deliberately not a simple/rolling
// average, which spikes on a single outlier bar. Returns null when there isn't enough history
// (needs 15 candles to form 14 true ranges) - callers must fall back to TOUCH_TOL, not treat
// null as zero volatility.
function atr14(candles) {
  var n = candles.length;
  if (n < 15) return null;
  var trs = [];
  for (var i = 1; i < n; i++) {
    var c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  var atr = 0;
  for (var j = 0; j < 14; j++) atr += trs[j];
  atr = atr / 14;
  for (var k = 14; k < trs.length; k++) atr = (atr * 13 + trs[k]) / 14;
  return atr;
}
// A3: per-coin touch tolerance, clamped. Falls back to the flat TOUCH_TOL (never a wider or
// narrower silent default) when ATR can't be computed (short history) or price is falsy.
function computeResearchTol(candles, price) {
  var a = atr14(candles);
  if (a == null || !price) return TOUCH_TOL;
  return clamp(TOUCH_TOL_ATR_MULT * a / price, TOUCH_TOL_MIN, TOUCH_TOL_MAX);
}

// A2: pivot search bounded to the trailing `windowSize` candles, with pivot indices offset
// back into FULL-SERIES index space (Step 6 plan review decision: full-series indices
// throughout, so railAt/candles[idx] need no downstream change). windowSize falsy or >= the
// series length is a no-op (whole series searched, offset 0) - same as findPivots(candles)
// directly.
function findPivotsWindowed(candles, windowSize) {
  var n = candles.length;
  var offset = (windowSize && n > windowSize) ? n - windowSize : 0;
  var sliceArr = offset ? candles.slice(offset) : candles;
  var p = findPivots(sliceArr);
  function shift(list) {
    return list.map(function(pt){ return {idx: pt.idx + offset, price: pt.price, time: pt.time}; });
  }
  return {highs: shift(p.highs), lows: shift(p.lows), offset: offset};
}

// A5: oldest/newest touch spacing + middle-touch gap. Only meaningful once there's a "middle"
// touch (>=3) - fewer touches never fails this check (there's nothing to space).
function passesAnchorSpacing(touches, minSpan, minGap) {
  if (touches.length < 3) return true;
  var idxs = touches.map(function(t){return t.idx;}).sort(function(a,b){return a-b;});
  var lo = idxs[0], hi = idxs[idxs.length-1];
  if (hi - lo < minSpan) return false;
  for (var i = 1; i < idxs.length-1; i++) {
    if (idxs[i]-lo < minGap || hi-idxs[i] < minGap) return false;
  }
  return true;
}

// B1 (Remediation spec, 2026-09-21/22; R2/R4 per Step 7 plan review): independent resistance
// fit. Mirrors the support pair-search's shape (pair -> slope/intercept -> touches ->
// anchor-spacing) but restricted to `highs` at or after `firstIdx` (the support fit's own
// window), and additionally gated on slope agreement with the support line. Returns the best
// candidate pair (most touches, ties broken by the most recent newest touch) or null when
// nothing clears 2+ touches with an agreeing slope - callers fall back to the parallel
// construction (B2) in that case. Complexity: candidates^2 pair search, same shape as the
// support loop, bounded by <=150 (1d) / <=40 (4d-grid) bars of pivots - negligible.
function fitIndependentResistance(highs, supSlope, supIntercept, firstIdx, tol, minAnchorSpan, minGap) {
  var candidates = highs.filter(function(h){ return h.idx >= firstIdx; });
  if (candidates.length < 2) return null;
  var supSlopePct = (supSlope / Math.abs(railAt(supSlope,supIntercept,firstIdx)||1)) * 100;
  var best = null;
  for (var a = 0; a < candidates.length-1; a++) {
    for (var b = a+1; b < candidates.length; b++) {
      var p1 = candidates[a], p2 = candidates[b];
      var idxDelta = p2.idx - p1.idx;
      if (idxDelta < 3) continue;
      var rSlope = (p2.price - p1.price) / idxDelta;
      var rIntercept = p1.price - rSlope * p1.idx;
      var touches = candidates.filter(function(h) {
        var exp = railAt(rSlope, rIntercept, h.idx);
        return exp > 0 && Math.abs(h.price-exp)/exp <= tol;
      });
      if (touches.length < 2) continue;
      if (!passesAnchorSpacing(touches, minAnchorSpan, minGap)) continue;
      var rSlopePct = (rSlope / Math.abs(railAt(rSlope,rIntercept,firstIdx)||1)) * 100;
      var agree = Math.abs(rSlope-supSlope) <= 0.5*Math.abs(supSlope) ||
        (Math.abs(supSlopePct) < NEAR_FLAT_SLOPE_PCT && Math.abs(rSlopePct) < NEAR_FLAT_SLOPE_PCT);
      if (!agree) continue;
      var newestTouchIdx = Math.max.apply(null, touches.map(function(t){return t.idx;}));
      if (!best || touches.length > best.touches.length ||
          (touches.length === best.touches.length && newestTouchIdx > best.newestTouchIdx)) {
        best = {slope:rSlope, intercept:rIntercept, touches:touches, newestTouchIdx:newestTouchIdx};
      }
    }
  }
  return best;
}

// B1: wedge rejection. sup(i) and res(i) are both linear in i, so their difference D(i) is
// linear too - checking the two endpoints of [firstIdx, endIdx] is sufficient to catch any
// crossing between them (a linear function can't dip and recover between two same-sign
// endpoints). endIdx is lastIdx+WEDGE_LOOKAHEAD, so this also rejects a pair that doesn't cross
// yet but converges within the lookahead window.
function isWedge(supSlope, supIntercept, resSlope, resIntercept, firstIdx, endIdx) {
  var dFirst = railAt(resSlope,resIntercept,firstIdx) - railAt(supSlope,supIntercept,firstIdx);
  var dEnd = railAt(resSlope,resIntercept,endIdx) - railAt(supSlope,supIntercept,endIdx);
  return dFirst <= 0 || dEnd <= 0;
}

// A1: scans every bar firstIdx..lastIdx for a rail-pair candidate. `probed` (low pierced
// rail*(1-tol)) is tracked separately from `broken-bar` (close pierced it) per H9's own
// distinction ("a touch inside the tolerance band is not evidence support held; a closed bar
// back above the rail after a probe is"). lastBreakIdx is the last bar of the MOST RECENT
// broken-bar run (chronological, not necessarily the longest) - barsSinceBreak is measured
// against it.
function scanBreaks(candles, slope, intercept, firstIdx, lastIdx, tol) {
  var maxRun = 0, curRun = 0, lastBreakIdx = -1, anyProbed = false;
  for (var i = firstIdx; i <= lastIdx; i++) {
    var thresh = railAt(slope, intercept, i) * (1 - tol);
    var c = candles[i];
    if (c.low < thresh) anyProbed = true;
    if (c.close < thresh) {
      curRun++;
      lastBreakIdx = i;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      curRun = 0;
    }
  }
  return {maxRun: maxRun, lastBreakIdx: lastBreakIdx, anyProbed: anyProbed};
}

// H9: lifecycle state from a scanBreaks() result. Step 6 build review (2026-09-22, "Review of
// Step 6 build", BLOCKS 2 / R2 correction): the original R2 prose's "broken" clause included
// "OR no support touch newer than lastBreakIdx", which duplicates the reclaimed-awaiting-retest
// condition and made that state unreachable under an if/elif-broken-first chain (the 0/2162
// result on the first build). Ryan's own error in the plan review text, corrected here to the
// four-rule order given in the build review, evaluated in this exact order on the winning pair
// over the fit window:
//   1. no low below rail*(1-tol)                                            -> intact
//   2. some low below, zero closes below                                    -> wick-probed
//   3. >=1 close below AND (last close still below OR barsSinceBreak<RECLAIM_BARS) -> broken
//   4. else (last close back above AND barsSinceBreak>=RECLAIM_BARS):
//        a support touch newer than lastBreakIdx exists                     -> re-qualified
//        otherwise                                                          -> reclaimed-awaiting-retest
// Rule 3 does NOT reference touches at all - that's what makes rule 4 (and therefore
// reclaimed-awaiting-retest) reachable.
function computeLifecycle(scan, touches, candles, slope, intercept, lastIdx, tol, reclaimBars) {
  // Rule 1: intact.
  if (!scan.anyProbed) {
    return {state:'intact', maxBreakRun:0, lastBreakIdx:-1, barsSinceBreak:null};
  }
  // Rule 2: wick-probed.
  if (scan.maxRun === 0) {
    return {state:'wick-probed', maxBreakRun:0, lastBreakIdx:-1, barsSinceBreak:null};
  }
  var lastBreakIdx = scan.lastBreakIdx;
  var barsSinceBreak = lastIdx - lastBreakIdx;
  var lastCloseBelow = candles[lastIdx].close < railAt(slope, intercept, lastIdx) * (1 - tol);
  // Rule 3: broken - no touch-newer clause here by design (see header note above).
  if (lastCloseBelow || barsSinceBreak < reclaimBars) {
    return {state:'broken', maxBreakRun:scan.maxRun, lastBreakIdx:lastBreakIdx, barsSinceBreak:barsSinceBreak};
  }
  // Rule 4: reclaimed - re-qualified if a touch since the break exists, else awaiting retest.
  var touchNewer = touches.some(function(t){ return t.idx > lastBreakIdx; });
  var state = touchNewer ? 're-qualified' : 'reclaimed-awaiting-retest';
  return {state:state, maxBreakRun:scan.maxRun, lastBreakIdx:lastBreakIdx, barsSinceBreak:barsSinceBreak};
}

// Step 6 (Remediation spec 2026-09-21/22; REVISED per Step 6 plan review 2026-09-22): the
// research fit. A FULL independent re-fit against A1-A5/H9 rules - windowed pivots (A2),
// per-coin ATR-scaled tol (A3), anchor spacing (A5), per-pair break-scan + lifecycle (A1/H9) -
// not an annotation of the flag-off `best`. R1: every candidate pair gets a lifecycle state;
// pair selection prefers the best-scoring ELIGIBLE (intact/re-qualified) pair, falling back to
// the best-scoring pair overall (carrying its ineligible state) only when no pair is eligible -
// so a coin with only broken candidates still returns a real, visible row, never null on that
// account alone (still returns null for the ordinary reasons: <30 candles, <3 low pivots, no
// candidate clears containment/position same as the flag-off path).
function detectChannelResearch(candles, diag, meta) {
  if (!candles || candles.length < 30) return null;
  // A5 rejection diagnostics (Step 6 build review handoff format): when the caller passes a
  // diag object, count every rail-pair candidate that reached the anchor-spacing check and how
  // many of those passesAnchorSpacing() rejected, keyed by timeframe. Optional and additive -
  // detectChannelResearch's return value and every existing behavior are unaffected whether or
  // not diag is passed.
  var tf = meta.timeframe || '1d';
  if (diag) {
    if (!diag.a5) diag.a5 = {};
    if (!diag.a5[tf]) diag.a5[tf] = {checked:0, rejected:0};
  }
  var timeframe = meta.timeframe || '1d'; // A2: meta.timeframe absent -> default 1d/150 (no current production caller hits this - see plan §3)
  var windowSize = (timeframe === '4d-grid') ? FIT_WINDOW_GRID : FIT_WINDOW;
  var minAnchorSpan = (timeframe === '4d-grid') ? MIN_ANCHOR_SPAN_GRID : MIN_ANCHOR_SPAN;

  var n = candles.length;
  var pv = findPivotsWindowed(candles, windowSize);
  var highs = pv.highs, lows = pv.lows;
  if (lows.length < 3 || highs.length < 1) return null;

  var price = candles[n-1].close;
  var tol = computeResearchTol(candles, price);
  var atr = atr14(candles);

  var ema = emaState(candles);
  // E3 (Remediation spec, 2026-09-21/22): research-only sibling, reusing this same `atr`
  // (computed just above) - flag-off's own bullEngulfing(candles) call, in detectChannel
  // below, is untouched.
  var conf = {bb3:bb3Reversion(candles), bullEngulf:bullEngulfingResearch(candles, atr), threeInsideUp:threeInsideUp(candles),
    bb3UpperReversion:bb3UpperReversion(candles), threeInsideDown:threeInsideDown(candles)};

  var bestEligible = null, bestAny = null;

  for (var a = 0; a < lows.length-1; a++) {
    for (var b = a+1; b < lows.length; b++) {
      var p1 = lows[a], p2 = lows[b];
      var idxDelta = p2.idx - p1.idx;
      if (idxDelta < 3) continue;

      var slope = (p2.price - p1.price) / idxDelta;
      if (slope < -0.05 * p1.price / idxDelta) continue;

      var intercept = p1.price - slope * p1.idx;

      var supTouches = lows.filter(function(l) {
        var exp = railAt(slope,intercept,l.idx);
        return exp > 0 && Math.abs(l.price-exp)/exp <= tol;
      });
      // Step 6 build-review handoff (changed-row/cause table): optional per-pair diagnostic
      // log, keyed by the pair's full-series pivot indices + slope so a caller (regression-
      // runner's runResearch) can match a flag-off winning pair to its research-mode fate by
      // exact identity rather than guessing from output fields alone. `reached` records the
      // last gate this pair cleared before falling out of the loop (or 'full' if it became a
      // real candidate); null fields below simply were never computed for a pair that fell out
      // earlier. Zero effect on detection output - only appended to, never read, by this code.
      var pairLogEntry = null;
      if (diag) {
        if (!diag.pairLog) diag.pairLog = [];
        pairLogEntry = {p1idx:p1.idx, p2idx:p2.idx, slope:slope, touches:supTouches.length,
          reached:'touches', anchorPass:null, eligible:null, lifecycleState:null, score:null};
        diag.pairLog.push(pairLogEntry);
      }
      if (supTouches.length < 3) continue;

      // A5
      if (diag) diag.a5[tf].checked++;
      var anchorOk = passesAnchorSpacing(supTouches, minAnchorSpan, MIN_TOUCH_GAP);
      if (pairLogEntry) { pairLogEntry.anchorPass = anchorOk; if (anchorOk) pairLogEntry.reached = 'anchor'; }
      if (!anchorOk) {
        if (diag) diag.a5[tf].rejected++;
        continue;
      }

      var firstIdx = Math.min.apply(null, supTouches.map(function(l){return l.idx;}));
      var lastIdx = n-1;
      var relHighs = highs.filter(function(h){return h.idx>=firstIdx;});
      if (!relHighs.length) continue;

      // B1: fit resistance independently first; B2 (recency-weighted parallel) is the fallback
      // only when no independent line clears 2+ touches with an agreeing slope.
      var resSlope, resIntercept, pivotHighs, resistanceFit;
      var resFit = fitIndependentResistance(highs, slope, intercept, firstIdx, tol, minAnchorSpan, MIN_TOUCH_GAP);
      if (resFit) {
        resSlope = resFit.slope; resIntercept = resFit.intercept;
        pivotHighs = resFit.touches; resistanceFit = 'independent';
      } else {
        var recentBars = (timeframe === '4d-grid') ? RES_RECENT_BARS_GRID : RES_RECENT_BARS;
        var relHighsRecent = relHighs.filter(function(h){ return h.idx >= n-recentBars; });
        if (!relHighsRecent.length) continue;
        var offsets = relHighsRecent.map(function(h){return h.price-railAt(slope,intercept,h.idx);}).filter(function(o){return o>0;});
        offsets.sort(function(x,y){return x-y;});
        if (!offsets.length) continue;
        var parallelChannelH = offsets[Math.floor(offsets.length/2)];
        if (parallelChannelH <= 0) continue;
        resSlope = slope; resIntercept = intercept + parallelChannelH;
        pivotHighs = []; resistanceFit = 'parallel';
      }

      // B1: wedge rejection - a pair whose rails cross inside the fit window, or converge
      // within the lookahead window past lastIdx, is not a channel.
      var lookahead = (timeframe === '4d-grid') ? WEDGE_LOOKAHEAD_GRID : WEDGE_LOOKAHEAD;
      if (isWedge(slope, intercept, resSlope, resIntercept, firstIdx, lastIdx+lookahead)) {
        if (pairLogEntry) pairLogEntry.reached = 'wedge';
        continue;
      }

      var resTouches = relHighs.filter(function(h) {
        var exp = railAt(resSlope,resIntercept,h.idx);
        return exp > 0 && Math.abs(h.price-exp)/exp <= tol;
      });

      var supNow = railAt(slope,intercept,lastIdx);
      var resNow = railAt(resSlope,resIntercept,lastIdx);
      var channelH = resNow - supNow; // R3: height AT THE DECISION BAR - constant on the parallel path, time-varying on the independent path
      if (channelH <= 0) continue;
      var curPrice = candles[lastIdx].close;
      var position = (curPrice-supNow)/channelH; // B4: unclamped, same rationale as the flag-off path
      var distToRailPct = (curPrice-supNow)/curPrice; // B5

      var winCandles = candles.slice(firstIdx);
      var inside = 0;
      for (var i=0; i<winCandles.length; i++) {
        var ci = firstIdx+i;
        var s = railAt(slope,intercept,ci);
        var r2 = railAt(resSlope,resIntercept,ci); // R3: both rails checked per bar, generalizes the old flat s+channelH
        if (winCandles[i].low >= s*(1-tol) && winCandles[i].high <= r2*(1+tol)) inside++;
      }
      var containment = (inside/winCandles.length)*100;
      if (containment < 55) continue;
      if (pairLogEntry) pairLogEntry.reached = 'containment';

      if (position > 0.75) continue;
      if (pairLogEntry) pairLogEntry.reached = 'position';

      // A1/H9
      var scan = scanBreaks(candles, slope, intercept, firstIdx, lastIdx, tol);
      var lifecycle = computeLifecycle(scan, supTouches, candles, slope, intercept, lastIdx, tol, RECLAIM_BARS);

      var slopePct = (slope / Math.abs(railAt(slope,intercept,firstIdx)||1)) * 100;
      var invalidation = supNow * (1-tol);

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
      score += ema.pts;
      var patternN = (conf.bb3.hit?1:0) + (conf.bullEngulf.hit?1:0) + (conf.threeInsideUp.hit?1:0);
      var patternBonus = patternN > 0 ? (2*patternN - 1) : 0;
      score += patternBonus;
      score = Math.round(clamp(score,0,100));

      var eligible = (lifecycle.state === 'intact' || lifecycle.state === 're-qualified');
      if (pairLogEntry) {
        pairLogEntry.reached = 'full'; pairLogEntry.eligible = eligible;
        pairLogEntry.lifecycleState = lifecycle.state; pairLogEntry.score = score;
      }
      var candidate = {
        score:score, supportTouches:supTouches.length, resTouches:resTouches.length,
        containment:Math.round(containment), slope:slopePct, position:position,
        supportNow:supNow, resistNow:resNow, invalidation:invalidation, channelH:channelH,
        distToRailPct:distToRailPct, // B5
        resSlope:resSlope, resIntercept:resIntercept, pivotHighs:pivotHighs, resistanceFit:resistanceFit, // B1/R3
        candles:candles.slice(-150), pivotLows:supTouches,
        supSlope:slope, supIntercept:intercept, firstIdx:firstIdx, lastIdx:lastIdx,
        isAscending:slope>=0, isFlat:Math.abs(slopePct)<0.1,
        emaState:ema.state, ema21:ema.e21, ema50:ema.e50, emaPts:ema.pts,
        bb3:conf.bb3.hit, bullEngulf:conf.bullEngulf.hit, threeInsideUp:conf.threeInsideUp.hit,
        bb3Trigger:conf.bb3, bullEngulfTrigger:conf.bullEngulf, threeInsideUpTrigger:conf.threeInsideUp,
        bb3UpperReversion:conf.bb3UpperReversion.hit, threeInsideDown:conf.threeInsideDown.hit,
        bb3UpperReversionTrigger:conf.bb3UpperReversion, threeInsideDownTrigger:conf.threeInsideDown,
        fitId: makeFitId(meta.coinId, meta.timeframe, meta.source, candles[lastIdx].time, firstIdx, lastIdx),
        timeframe: meta.timeframe || null,
        candleSource: meta.source || null,
        lookback: Math.min(n, windowSize),
        fitStartTime: candles[firstIdx].time,
        fitEndTime: candles[lastIdx].time,
        schemaVersion: FIT_SCHEMA_VERSION,
        detectorVersion: DETECTOR_VERSION,
        containmentFull: Math.round(containment),
        containmentRecent: computeRecentContainment(candles, slope, intercept, channelH, firstIdx, lastIdx),
        touchEvents: supTouches,
        pivotIds: supTouches.map(function(t){ return t.time; }),
        nearestResistance: resNow,
        detectionPrice: curPrice,
        detectionAsOf: candles[lastIdx].time,
        lifecycleState: lifecycle.state,
        maxBreakRun: lifecycle.maxBreakRun,
        lastBreakIdx: lifecycle.lastBreakIdx,
        barsSinceBreak: lifecycle.barsSinceBreak,
        tol: tol,
        atr14: atr,
        research: true,
        breachHistory: []
      };

      if (eligible && (!bestEligible || candidate.score > bestEligible.score)) bestEligible = candidate;
      if (!bestAny || candidate.score > bestAny.score) bestAny = candidate;
    }
  }

  var winner = bestEligible || bestAny; // R1: eligible pair preferred; else best-scoring pair carries its ineligible state
  if (!winner) return null;

  var rocket = rocketAtSupport(candles, winner.supSlope, winner.supIntercept);
  var bb3Coincidence = conf.bb3.hit ? {hit:true, idx:n-1, time:candles[n-1].time} : conf.bb3;
  var multi = multiSignalOnOneCandle([bb3Coincidence, conf.bullEngulf, conf.threeInsideUp, rocket]);
  winner.rocket = rocket.hit;
  winner.rocketTrigger = rocket;
  winner.multiSignal = multi.hit;
  winner.multiSignalTrigger = multi;

  return winner;
}

// --- Channel detection (scoring + per-coin diag) ---
// H7: OPTIONAL third arg `meta` ({coinId, timeframe, source}) - see header note. Every
// existing 2-arg caller is unaffected (meta defaults to {}).
// Step 6 (2026-09-22): meta.research===true routes to detectChannelResearch above INSTEAD of
// the body below - a per-call dispatch (R3: no module-level RESEARCH_MODE), so the body below
// is completely unmodified source and the flag-off output is unaffected by this change by
// construction, not by discipline.
function detectChannel(candles, diag, meta) {
  if(!meta) meta = {};
  if(meta.research) return detectChannelResearch(candles, diag, meta);
  if(!diag) diag = {universe:0,volExcluded:0,catExcluded:0,ohlcOk:0,railPairs:0,posSlope:0,touches:0,containment:0,scoreOk:0,candidates:0};
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
      // B4 (Remediation spec, 2026-09-21/22): UNCLAMPED - a close below support is a real,
      // negative position (rail broken), not 0; a close above resistance is a real position
      // >1, not 1. The position>0.75 gate two lines below and the position<=0.33/0.5/0.66
      // score bonus further down are UNCHANGED by this: a negative value still satisfies
      // <=0.75/<=0.33 exactly as the old clamped-to-0 value did, and a >1 value still fails
      // both exactly as the old clamped-to-1 value did - clamping only ever mattered at the
      // boundaries this gate/bonus already treat identically. Clamping for DISPLAY (the
      // position bar's width/marker) now happens only at the renderer in radar.html, per
      // spec; buildAction there reads the raw value to distinguish "below support - rail
      // broken" from "lower third" instead of the two being indistinguishable at 0.
      var position = (curPrice-supNow)/channelH;

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
    computeRecentContainment: computeRecentContainment, detectChannel: detectChannel,
    // Step 6 (Remediation spec, 2026-09-21/22) exports - constants for capture.js's configHash
    // (so any future tuning is hashed like every other constant) and the research internals
    // for direct harness testing (invariant checks, e.g. railAt(...)===supportNow).
    FIT_WINDOW: FIT_WINDOW, FIT_WINDOW_GRID: FIT_WINDOW_GRID, BREAK_RUN_MAX: BREAK_RUN_MAX,
    RECLAIM_BARS: RECLAIM_BARS, MIN_ANCHOR_SPAN: MIN_ANCHOR_SPAN,
    MIN_ANCHOR_SPAN_GRID: MIN_ANCHOR_SPAN_GRID, MIN_TOUCH_GAP: MIN_TOUCH_GAP,
    TOUCH_TOL_ATR_MULT: TOUCH_TOL_ATR_MULT, TOUCH_TOL_MIN: TOUCH_TOL_MIN, TOUCH_TOL_MAX: TOUCH_TOL_MAX,
    atr14: atr14, computeResearchTol: computeResearchTol, findPivotsWindowed: findPivotsWindowed,
    passesAnchorSpacing: passesAnchorSpacing, scanBreaks: scanBreaks, computeLifecycle: computeLifecycle,
    detectChannelResearch: detectChannelResearch,
    // E3 (Remediation spec, 2026-09-21/22) exports - constants for capture.js's configHash and
    // the function itself for direct harness testing.
    ENGULF_BODY_ATR_MULT: ENGULF_BODY_ATR_MULT, ENGULF_BODY_RATIO: ENGULF_BODY_RATIO,
    bullEngulfingResearch: bullEngulfingResearch,
    // Step 7 (Remediation spec, 2026-09-21/22) exports - constants for capture.js's configHash
    // and the B1 internals for direct harness testing.
    NEAR_FLAT_SLOPE_PCT: NEAR_FLAT_SLOPE_PCT, WEDGE_LOOKAHEAD: WEDGE_LOOKAHEAD,
    WEDGE_LOOKAHEAD_GRID: WEDGE_LOOKAHEAD_GRID, RES_RECENT_BARS: RES_RECENT_BARS,
    RES_RECENT_BARS_GRID: RES_RECENT_BARS_GRID,
    fitIndependentResistance: fitIndependentResistance, isWedge: isWedge
  };
}
