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

// E5 (Remediation spec, 2026-09-21/22): research-only sibling to threeInsideUp() above -
// flag-off untouched (detectChannel's own conf.threeInsideUp call, below, still calls
// threeInsideUp() directly). Same style as bullEngulfingResearch/rocketAtSupportResearch: one
// added confirmation gate, no re-derivation of the base pattern. Per Ryan's restage
// instruction (2026-09-23): threeInsideUpResearch = threeInsideUp's own four conditions, plus
// c3 (the confirmation candle) closing back above c1's open - i.e. the inside-bar setup isn't
// just "up from c2's close" (threeInsideUp's own c3Up test) but has actually reclaimed the
// first bearish candle's open, a stronger confirmation of the reversal. No new constants -
// c1.open is already a field on the candle object, nothing to tune or fold into configHash.
function threeInsideUpResearch(candles) {
  var n=candles.length; if(n<3) return {hit:false, idx:null, time:null};
  var c1=candles[n-3], c2=candles[n-2], c3=candles[n-1];
  var c1Bear = c1.close<c1.open;
  var c2Bull = c2.close>c2.open;
  var c2Inside = Math.max(c2.open,c2.close)<=c1.open && Math.min(c2.open,c2.close)>=c1.close;
  var c3Up = c3.close>c2.close;
  var c3ReclaimsC1Open = c3.close>c1.open;
  var hit = c1Bear && c2Bull && c2Inside && c3Up && c3ReclaimsC1Open;
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

// E4 (Remediation spec, 2026-09-21/22): research-only sibling to rocketAtSupport() above -
// flag-off untouched, called only from detectChannelResearch's post-winner rocket call (the
// OTHER rocketAtSupport call, inside flag-off detectChannel below, is untouched). Two changes
// from the base function: the near-rail anchor switches from the candle's BODY low (bodyLow,
// what rocketAtSupport tests) to its WICK low (c.low), per the spec's literal wording - this
// can pass bars flag-off would reject and reject bars flag-off would pass; report the
// population delta, no tuning on any single coin. And three added gates: a lower-wick size
// floor relative to the candle's own body AND to ATR14 (atr reused from the caller, same
// convention as E3's atr arg - no new ATR computation here), a lifecycle-validity gate (fires
// only on a currently-eligible rail - same 'intact'/'re-qualified' test detectChannelResearch
// already computes for bestEligible, passed in rather than re-derived), and a reclaim-not-
// bounce guard (no fire if the prior ROCKET_PRIOR_CLOSES_BELOW closes were ALL below their own
// rail value - a rocket needs the rail to have actually been holding, not just poked at from
// underneath once). Missing history for the prior-5 guard (near the start of a series) can't
// prove "all below", so it doesn't block - this guard only ever removes fires, never requires
// history to exist.
var ROCKET_WICK_BODY = 1.5;         // PROVISIONAL, spec E4: lowerWick >= this * |close-open|.
var ROCKET_WICK_ATR = 0.5;          // PROVISIONAL, spec E4: lowerWick >= this * ATR14.
var ROCKET_PRIOR_CLOSES_BELOW = 5;  // PROVISIONAL, spec E4: no fire if this many prior closes are all below the rail.
function rocketAtSupportResearch(candles, supSlope, supIntercept, tol, atr, lifecycleState) {
  var n = candles.length; if(n < 1) return {hit:false, idx:null, time:null};
  var i = n-1, c = candles[i];
  if(!(c.close > c.open)) return {hit:false, idx:null, time:null}; // must be a green candle, same as rocketAtSupport
  var range = c.high - c.low;
  if(range <= 0) return {hit:false, idx:null, time:null};
  var bodyLow = Math.min(c.open, c.close);
  var railVal = railAt(supSlope, supIntercept, i);
  if(!(railVal > 0)) return {hit:false, idx:null, time:null};
  // E4: anchor is the WICK low (c.low), not the body low rocketAtSupport tests.
  var nearRail = Math.abs(c.low - railVal) / railVal <= tol;
  var lowerWick = bodyLow - c.low;
  var body = Math.abs(c.close - c.open);
  var wickSizeOk = (atr != null) && (lowerWick > 0) &&
    (lowerWick >= ROCKET_WICK_BODY * body) && (lowerWick >= ROCKET_WICK_ATR * atr);
  var closesNearHigh = (c.high - c.close) <= ROCKET_CLOSE_TOL * range;
  var lifecycleOk = (lifecycleState === 'intact') || (lifecycleState === 're-qualified');
  var allPriorBelow = true;
  for (var k = 1; k <= ROCKET_PRIOR_CLOSES_BELOW; k++) {
    var pi = i - k;
    if (pi < 0) { allPriorBelow = false; break; }
    var pRail = railAt(supSlope, supIntercept, pi);
    if (!(pRail > 0) || !(candles[pi].close < pRail)) { allPriorBelow = false; break; }
  }
  var hit = nearRail && wickSizeOk && closesNearHigh && lifecycleOk && !allPriorBelow;
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

// E6 (Remediation spec, 2026-09-21/22): conflict rule - a bullish trigger and a bearish
// trigger firing on the same or adjacent candles undermine each other, so research mode
// shouldn't award the pattern bonus for it and should surface the conflict for H11's popover.
// Used ONLY by detectChannelResearch below (bearish counterparts bb3UpperReversion/
// threeInsideDown are pure, flag-off-only inputs already in `conf`, untouched by E3-E5).
// Same adjacency convention multiSignalOnOneCandle uses above (|idx delta| <= N on each
// pattern's own idx), widened from <=1 to <=2 per spec and checked cross-polarity (a bullish
// set against a bearish set) instead of same-polarity. Returns the first conflicting
// {bullish, bearish} trigger pair found, or null - "a reference to which pair conflicted",
// not every pair; scanned in the order the caller passes triggers in.
function signalConflict(bullishTriggers, bearishTriggers) {
  var bulls = bullishTriggers.filter(function(t){ return t && t.hit && t.idx != null; });
  var bears = bearishTriggers.filter(function(t){ return t && t.hit && t.idx != null; });
  for (var i=0; i<bulls.length; i++) {
    for (var j=0; j<bears.length; j++) {
      if (Math.abs(bulls[i].idx - bears[j].idx) <= 2) {
        return {bullish: bulls[i], bearish: bears[j]};
      }
    }
  }
  return null;
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
// Step 10 D: optional `countRuns` (research call only) adds runCount2 = number of DISTINCT runs of exactly
// 2 consecutive closes below the band. Absent -> the returned object is exactly what it was before, so
// every flag-off caller is byte-unchanged.
function scanBreaks(candles, slope, intercept, firstIdx, lastIdx, tol, countRuns) {
  var maxRun = 0, curRun = 0, lastBreakIdx = -1, anyProbed = false, runCount2 = 0;
  for (var i = firstIdx; i <= lastIdx; i++) {
    var thresh = railAt(slope, intercept, i) * (1 - tol);
    var c = candles[i];
    if (c.low < thresh) anyProbed = true;
    if (c.close < thresh) {
      curRun++;
      lastBreakIdx = i;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      if (curRun === 2) runCount2++;
      curRun = 0;
    }
  }
  if (curRun === 2) runCount2++;
  var out = {maxRun: maxRun, lastBreakIdx: lastBreakIdx, anyProbed: anyProbed};
  if (countRuns) out.runCount2 = runCount2;
  return out;
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
// H11 (Remediation spec, 2026-09-21/22): pattern inspectability records. Used ONLY by
// detectChannelResearch below, after the winner is chosen. One record per fired pattern among
// bb3, bullEngulf, threeInsideUp, rocket, bb3UpperReversion, threeInsideDown - each carries
// where it came from (venue/timeframe/interval, the same meta values fitId is built from),
// the referenced candles (times + OHLC read straight off `candles`), and a rule string built
// from the module constants at call time so it can never drift from the thresholds actually
// applied. `closed` is always true: every candle reaching detection is a closed bar (F1/F2),
// there is no wall-clock check here. bb3 / bb3UpperReversion / three-inside rules have no named
// constants (their thresholds are literals inside their own functions, untouched) so their rule
// text describes the test without a tunable value beyond the Bollinger 20/3/5 shape.
// conflictingSignalsPair (E6) is carried on the two records whose triggers form the pair (same
// object as winner.conflictingSignalsPair); null on every other record.
function buildPatternRecords(candles, conf, rocket, conflict, meta, tol, lifecycleState) {
  var n = candles.length;
  var records = [];
  function add(name, trig, idxs, rule) {
    if (!trig || !trig.hit) return;
    var involved = !!conflict && (conflict.bullish === trig || conflict.bearish === trig);
    records.push({
      pattern: name,
      venue: meta.source || null,
      timeframe: meta.timeframe || null,
      interval: meta.timeframe || null,
      closed: true,
      candleIds: idxs.map(function(i){ return candles[i].time; }),
      ohlc: idxs.map(function(i){
        var c = candles[i];
        return {time:c.time, open:c.open, high:c.high, low:c.low, close:c.close};
      }),
      rule: rule,
      conflictingSignalsPair: involved ? conflict : null
    });
  }
  add('bb3', conf.bb3, [conf.bb3.idx],
    'bb3 reversion: this bar\'s low pierced the lower Bollinger band (20-bar mean, 3 std) within the last 5 bars; latest close is back inside the band');
  add('bullEngulf', conf.bullEngulf, [n-2, n-1],
    'bullish engulfing (research): bearish prior bar, bullish trigger bar; trigger body >= ' + ENGULF_BODY_ATR_MULT +
    'x ATR14 and >= ' + ENGULF_BODY_RATIO + 'x prior body; trigger close > prior open, trigger open <= prior close; ' +
    'close 3 bars before the trigger > prior close');
  add('threeInsideUp', conf.threeInsideUp, [n-3, n-2, n-1],
    'three inside up (research): bearish bar 1, bullish bar 2 inside bar 1 body, bar 3 closes above bar 2 close and above bar 1 open');
  add('rocket', rocket, [n-1],
    'custom support-rejection pattern: green bar; wick low within ' + (tol * 100).toFixed(2) + '% of the support rail; ' +
    'lower wick >= ' + ROCKET_WICK_BODY + 'x body and >= ' + ROCKET_WICK_ATR + 'x ATR14; ' +
    'close within ' + ROCKET_CLOSE_TOL + ' of the bar range below the high; rail lifecycle ' + lifecycleState +
    '; not all of the prior ' + ROCKET_PRIOR_CLOSES_BELOW + ' closes were below the rail');
  add('bb3UpperReversion', conf.bb3UpperReversion, [conf.bb3UpperReversion.idx],
    'bb3 upper reversion (bearish exit warning): this bar\'s high pierced the upper Bollinger band (20-bar mean, 3 std) within the last 5 bars; latest close is back inside the band');
  add('threeInsideDown', conf.threeInsideDown, [n-3, n-2, n-1],
    'three inside down (bearish exit warning): bullish bar 1, bearish bar 2 inside bar 1 body, bar 3 closes below bar 2 close');
  return records;
}

// Step 9 F3 (Remediation spec, 2026-09-21/22; plan approved 2026-09-23): outlier-wick filter.
// RESEARCH-ONLY - called only from detectChannelResearch below (meta.research === true); flag-off
// detectChannel never sees it. PROVISIONAL constants, exported, hashed into capture.js's configHash.
//   F3_WICK_ATR_MULT: a low is an outlier when low < close - this * ATR14 (mirror for high).
//   F3_CLIP_ATR_MULT: the analytic low becomes min(open,close) - this * ATR14 (mirror for high).
//   F3_RAIL_UNCHANGED_PCT: H3 - |support/resistance rail delta| below this many percent reads "rail unchanged".
var F3_WICK_ATR_MULT = 6;
var F3_CLIP_ATR_MULT = 2;
var F3_RAIL_UNCHANGED_PCT = 0.05;

// Step 10 D (Remediation spec Plan D, 2026-09-21/22; plan + review decisions in the step 8-10 log): the research
// score rebalance. ALL PROVISIONAL, research-only (detectChannelResearch; flag-off detectChannel's score is
// untouched). Positive components sum to D_RAW_MAX = 102 and are rescaled x100/102 ONCE (D_RAW_MAX); penalties
// are absolute points subtracted after the rescale; the result is clamped to 0..100 (review decision c).
var D_TOUCH_PTS = [0, 10, 16, 20, 22, 24];  // support touches 2,3,4,5,6,7+ (index min(n,7)-2)
var D_RES_PTS = [0, 8, 12, 15];             // resistance touches 0,1,2,3+ (index min(n,3))
var D_RES_PARALLEL_MAX = 6;                 // cap when the resistance is the parallel fallback (B2)
var D_CONT_GATE = 70;                       // % of bar CLOSES inside the channel; also the pair-eligibility gate (research)
var D_CONT_MAX = 15;                        // points = (pct - D_CONT_GATE)/(100 - D_CONT_GATE) * D_CONT_MAX
var D_BREAK_PENALTY = 10;                   // points per distinct break run of exactly 2 closes (runCount2)
var D_POS_MULT = [2, 4];                    // distToRailPct <= min(2*tol, D_POS_FULL_CAP) -> full, <= 4*tol -> middle
var D_POS_FULL_CAP = 0.06;                  // same cap as the B5 ACT gate in radar.html buildAction
var D_POS_PTS = [12, 6, 0];
var D_AGE_RANGE = [30, 120, 150];           // 1d bars: 0 at/below [0], linear to D_AGE_MAX at [1], held to [2], 0 above [2]
var D_AGE_RANGE_GRID = [8, 30, 40];         // 4d-grid bars (= daily range / 4; ceiling = FIT_WINDOW_GRID)
var D_AGE_MAX = 6;
var D_WIDTH_FRAC = [0.40, 0.60];            // channelH / price thresholds
var D_WIDTH_PENALTY = [8, 15];
var D_EMA_SLOPE_BONUS = 3;                  // +3 iff ema50Slope > 0 (no above-50 requirement)
var D_EMA_SLOPE_BARS = 10;                  // ema50Slope = (ema50[n-1] - ema50[n-1-N]) / ema50[n-1-N}, N = 10 (C1)
var D_PATTERN_MAX = 3;                      // 1D only, capped min(D_PATTERN_MAX, 2n-1); 0 on conflict (E6) and on 4d-grid
var D_VOL_TOUCH_BONUS = 4;
var D_VOL_TOUCH_MULT = 1.2;
var D_VOL_WINDOW = 20;                      // mean of the 20 bars BEFORE the most recent support touch bar (exclusive)
var D_RAW_MAX = 102;                        // 24+15+15+15+12+6+(5+3)+3+4
// Step 11-A (Remediation spec Plan C, C1-C7; H6 R:R stub; Verdict sequence 785-814). Research-only:
// consumed by researchVerdict() below, which the page calls from buildAction(r,{research:true}) and the
// runner calls directly. Nothing here is read by detectChannel (flag-off). Status per constant:
// spec-given = the value is written in the spec; PROVISIONAL = set by the analysis thread from the
// harness (step 11 plan review, rulings k/b) and may move before promotion (step 13).
var C1_EMA_SLOPE_MIN = 0;          // spec C1: ema50Slope >= 0 (slope over D_EMA_SLOPE_BARS, the one slope)
var C3_FRESH_BARS = 14;            // spec C3/A4: last support touch <= 14 (1d) bars ago AND no break inside 14 bars
var C3_FRESH_BARS_GRID = 4;        // PROVISIONAL (ruling a): 4d-grid day-equivalent of 14 d (same convention as MIN_ANCHOR_SPAN_GRID)
var ACT_WIDTH_MAX = 0.40;          // spec B3: channelH / price above this cannot be ACT (page keeps its own flag-off literal)
var C2_DIST_TOL_MULT = 2;          // spec B5: distToRailPct <= min(C2_DIST_TOL_MULT*tol, C2_DIST_CAP). Replaced by H6 in 11-B (ruling g).
var C2_DIST_CAP = 0.06;            // spec B5
var C4_VOLUME24H_MIN = 25e6;       // spec C4: 24h USD volume floor for ACT (the funnel's low-volume exclusion, made explicit)
var C4_VOL_TOUCH_MIN = 0.8;        // spec C4: touch-bar volume >= 0.8 x mean of the 20 bars before it (D's volTouch.ratio; distinct from D_VOL_TOUCH_MULT 1.2)
var C5_BTC_SLOPE_MIN = 0;          // spec C5: BTC above its EMA50 and ema50Slope >= 0, else "WATCH: BTC regime"
var C6_SPIKE_BARS = 3;             // spec C6: gain over the last 3 bars ...
var C6_SPIKE_ATR_MULT = 4;         // spec C6: ... above 4 x ATR14 -> WATCH extended
var H6_RR_MIN = 2.0;               // spec H6: net reward-to-risk >= 2.0. 11-A: no entryEconomics field yet -> Unknown -> gate fails (11-B lands it)
var ACT_SCORE_FLOOR_1D = 80;       // PROVISIONAL (ruling k; step 10 floor table: NEW@80 = 19 ACT over 24 dates vs OLD@89 = 18). Gate 11, Evidence stage.
var ACT_SCORE_FLOOR_GRID = 66;     // PROVISIONAL (ruling k/b): the 1d share of OLD(_noD)>=89 research rows (96/1569 = 6.12%) applied to the grid NEW score distribution (458 fits, max 79) -> 66; the runner step 11-A section re-derives it and flags a mismatch. Unreachable this step anyway (grid rows fail C4 touch-volume: no grid volume).

// 11-A: today's radar.html structureLabelFor(r), moved here so the verdict engine has no page dependency.
function structureLabelOf(fit) { return fit.isFlat ? 'flat' : (fit.slope > 0 ? 'ascending' : 'descending'); }

// 11-A / C5: BTC regime from BTC's own daily candles (capture.js's data/cache/bitcoin.json ohlcDaily; the runner's
// fixture copy sliced to the date). Same emaLast + D_EMA_SLOPE_BARS definition as the alt ema50Slope, so capture, page
// and runner cannot disagree. Returns null when there is no series; ema50Slope null when the series is too short.
function btcRegimeFromCandles(candles) {
  if (!candles || !candles.length) return null;
  var closes = candles.map(function(c){ return c.close; });
  var n = closes.length, e50 = emaLast(closes, 50), slope = null;
  if (n > D_EMA_SLOPE_BARS) {
    var e50Prev = emaLast(closes.slice(0, n - D_EMA_SLOPE_BARS), 50);
    if (e50Prev > 0) slope = (e50 - e50Prev) / e50Prev;
  }
  var last = candles[n-1];
  return { close: last.close, ema50: e50, ema50Slope: slope, aboveEma50: last.close > e50, asOf: last.time != null ? last.time : null, bars: n };
}

// 11-A: the research verdict engine. Pure: reads only `fit` and `ctx`, no DOM, no globals beyond the constants above,
// no Date. Gate order = spec Verdict sequence (Data -> Structure -> Evidence -> Entry -> Context) with Plan C mapped in
// (step 11 plan, 11-A table; 16 gates after the Diff A review removed struct.descending / struct.upper-third). EVERY gate is evaluated (details.gates, diagnostic, non-short-circuit);
// verdict/reason/gate come from the FIRST gate whose pass !== true. Unknown input (pass === null) fails a gate exactly
// like a false. No score bypasses a gate.
//   ctx = { price, volume24h, btc:{aboveEma50, ema50Slope}|null, quote:{ageSec|null, spreadPct|null}|null, floor }
//   returns { verdict:'ACT'|'WATCH'|'WAIT'|'NONE', reason, gate, stage, details:{ gates:[...], meetsFloor, firstFail } }
function researchVerdict(fit, ctx) {
  ctx = ctx || {};
  var gates = [], label = null;
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function add(id, stage, pass, value, threshold, failVerdict, reason) {
    gates.push({ id:id, stage:stage, pass:pass, value:(value === undefined ? null : value), threshold:(threshold === undefined ? null : threshold), failVerdict:failVerdict, reason:reason });
  }
  // 1 Data: fit
  var fitOk = !!(fit && num(fit.supportNow) && num(fit.invalidation) && num(fit.atr14) && num(fit.lastIdx));
  add('data.fit', 'Data', fitOk, fit ? 'fit' : null, 'supportNow/invalidation/atr14/lastIdx finite', 'NONE', 'data-unavailable');
  // 2 Data: price
  var priceOk = num(ctx.price) && ctx.price > 0;
  add('data.price', 'Data', (ctx.price == null) ? null : priceOk, num(ctx.price) ? ctx.price : null, '> 0', 'NONE', 'price-unknown');
  if (!fitOk) return finish();
  var tf = fit.timeframe || '1d', isGrid = (tf === '4d-grid');
  // 3 Structure: lifecycle (H9: only intact / re-qualified can be ACT)
  var ls = fit.lifecycleState;
  var lsPass = (ls === 'intact' || ls === 're-qualified') ? true : (ls == null ? null : false);
  var lsVerdict = ls === 'broken' ? 'WAIT' : 'WATCH';
  var lsReason = ls === 'broken' ? 'rail-broken' : (ls === 'reclaimed-awaiting-retest' ? 'awaiting-retest' : (ls === 'wick-probed' ? 'wick-probed' : 'lifecycle-unknown'));
  add('struct.lifecycle', 'Structure', lsPass, ls == null ? null : ls, 'intact | re-qualified', lsVerdict, lsReason);
  // 4 Structure: current-quote breach. PASS when ctx.price >= invalidation; breach (WAIT) when below. Unknown price -> null.
  add('struct.quote-breach', 'Structure', priceOk ? (ctx.price >= fit.invalidation) : null, priceOk ? ctx.price : null, fit.invalidation, 'WAIT', 'quote-breach');
  // 5 Structure: below rail (B4)
  add('struct.below-rail', 'Structure', num(fit.position) ? (fit.position >= 0) : null, num(fit.position) ? fit.position : null, '>= 0', 'WAIT', 'below-support');
  // Rail slope is a structure LABEL only (spec C1; Diff A review): no descending gate, no thirds gate - "not at
  // support" is C2.distance. The label rides in details for the page.
  label = (num(fit.slope) || fit.isFlat) ? structureLabelOf(fit) : null;
  // 6 Structure: C1 trend
  var c1Known = num(fit.detectionPrice) && num(fit.ema50) && num(fit.ema50Slope);
  add('C1.trend', 'Structure', c1Known ? (fit.detectionPrice > fit.ema50 && fit.ema50Slope >= C1_EMA_SLOPE_MIN) : null,
      c1Known ? { close: fit.detectionPrice, ema50: fit.ema50, ema50Slope: fit.ema50Slope } : null, 'close > ema50 && ema50Slope >= ' + C1_EMA_SLOPE_MIN, 'WATCH', 'base-forming');
  // 7 Evidence: C3 fresh touch
  var freshBars = isGrid ? C3_FRESH_BARS_GRID : C3_FRESH_BARS;
  var touches = fit.touchEvents || fit.pivotLows || [], maxTouchIdx = -1;
  for (var ti = 0; ti < touches.length; ti++) if (num(touches[ti].idx) && touches[ti].idx > maxTouchIdx) maxTouchIdx = touches[ti].idx;
  var barsSinceTouch = (maxTouchIdx >= 0) ? fit.lastIdx - maxTouchIdx : null;
  add('C3.fresh-touch', 'Evidence', barsSinceTouch == null ? null : (barsSinceTouch <= freshBars), barsSinceTouch, '<= ' + freshBars, 'WATCH', 'unconfirmed');
  // 8 Evidence: C3 no recent break (null barsSinceBreak = never broke)
  var bsb = fit.barsSinceBreak;
  add('C3.no-recent-break', 'Evidence', (bsb == null) ? true : (num(bsb) ? bsb >= freshBars : null), bsb == null ? null : bsb, '>= ' + freshBars + ' (or never)', 'WATCH', 'unconfirmed');
  // 9 Evidence: C7 score floor (ruling k: a gate, the Evidence-stage proxy for structure quality)
  var floorKnown = num(fit.score) && num(ctx.floor);
  add('C7.floor', 'Evidence', floorKnown ? (fit.score >= ctx.floor) : null, num(fit.score) ? fit.score : null, num(ctx.floor) ? ctx.floor : null, 'WATCH', 'below-floor');
  // 10 Entry: C2 width (B3)
  var widthFrac = (num(fit.channelH) && num(fit.detectionPrice) && fit.detectionPrice > 0) ? fit.channelH / fit.detectionPrice : null;
  add('C2.width', 'Entry', widthFrac == null ? null : (widthFrac <= ACT_WIDTH_MAX), widthFrac, '<= ' + ACT_WIDTH_MAX, 'WATCH', 'too-wide');
  // 11 Entry: C2 distance (B5) - replaced by the H6 entry zone in 11-B (ruling g)
  var distGate = num(fit.tol) ? Math.min(C2_DIST_TOL_MULT * fit.tol, C2_DIST_CAP) : null;
  add('C2.distance', 'Entry', (num(fit.distToRailPct) && distGate != null) ? (fit.distToRailPct <= distGate) : null, num(fit.distToRailPct) ? fit.distToRailPct : null, distGate, 'WATCH', 'not-at-support');
  // 12 Entry: C6 spike - close-to-close gain over the last C6_SPIKE_BARS bars vs C6_SPIKE_ATR_MULT x ATR14 (ruling m)
  var cs = fit.candles, gain = null;
  if (cs && cs.length > C6_SPIKE_BARS) {
    var cLast = cs[cs.length - 1], cPrev = cs[cs.length - 1 - C6_SPIKE_BARS];
    if (cLast && cPrev && num(cLast.close) && num(cPrev.close)) gain = cLast.close - cPrev.close;
  }
  add('C6.spike', 'Entry', gain == null ? null : (gain <= C6_SPIKE_ATR_MULT * fit.atr14), gain, C6_SPIKE_ATR_MULT * fit.atr14, 'WATCH', 'extended');
  // 13 Entry: H6 net R:R - 11-A stub: no entryEconomics field yet -> Unknown -> fail (11-B lands it)
  var ee = fit.entryEconomics;
  add('H6.rr', 'Entry', (ee && num(ee.netRR)) ? (ee.netRR >= H6_RR_MIN) : null, (ee && num(ee.netRR)) ? ee.netRR : null, '>= ' + H6_RR_MIN, 'WATCH', (ee && num(ee.netRR)) ? 'rr-too-low' : 'rr-unknown');
  // 14 Context: C4 volume24h
  add('C4.volume24h', 'Context', num(ctx.volume24h) ? (ctx.volume24h >= C4_VOLUME24H_MIN) : null, num(ctx.volume24h) ? ctx.volume24h : null, '>= ' + C4_VOLUME24H_MIN, 'WATCH', num(ctx.volume24h) ? 'low-volume' : 'volume-unknown');
  // 15 Context: C4 touch-bar volume (D's volTouch; null on grid rows / < 20 prior bars / missing volume)
  var vt = fit.scoreBreakdown && fit.scoreBreakdown.volTouch;
  var vtKnown = !!(vt && num(vt.ratio));
  add('C4.touch-volume', 'Context', vtKnown ? (vt.ratio >= C4_VOL_TOUCH_MIN) : null, vtKnown ? vt.ratio : null, '>= ' + C4_VOL_TOUCH_MIN, 'WATCH', vtKnown ? 'dead-volume' : 'touch-volume-unknown');
  // 16 Context: C5 BTC regime
  var btc = ctx.btc, btcKnown = !!(btc && typeof btc.aboveEma50 === 'boolean' && num(btc.ema50Slope));
  add('C5.btc-regime', 'Context', btcKnown ? (btc.aboveEma50 && btc.ema50Slope >= C5_BTC_SLOPE_MIN) : null, btcKnown ? { aboveEma50: btc.aboveEma50, ema50Slope: btc.ema50Slope } : null, 'aboveEma50 && ema50Slope >= ' + C5_BTC_SLOPE_MIN, 'WATCH', btcKnown ? 'btc-regime' : 'btc-regime-unknown');
  return finish();

  function finish() {
    var first = null;
    for (var i = 0; i < gates.length; i++) if (gates[i].pass !== true) { first = gates[i]; break; }
    var meetsFloor = (fit && num(fit.score) && num(ctx.floor)) ? (fit.score >= ctx.floor) : null;
    if (!first) return { verdict:'ACT', reason:'all-gates', gate:null, stage:null, details:{ gates:gates, meetsFloor:meetsFloor, firstFail:null, structureLabel:label } };
    return { verdict:first.failVerdict, reason:first.reason, gate:first.id, stage:first.stage, details:{ gates:gates, meetsFloor:meetsFloor, firstFail:first.id, structureLabel:label } };
  }
}

// ATR14 as of EVERY bar: out[k] = atr14(candles.slice(0, k+1)), null for k < 14. Same true-range math
// and same Wilder smoothing as atr14() above, evaluated as a rolling series instead of once at the
// end of the series (identical arithmetic order, so the values are bitwise equal - the suite checks
// every index). Not a second ATR definition.
function atr14Series(candles) {
  var n = candles.length, out = new Array(n);
  for (var k = 0; k < n; k++) out[k] = null;
  if (n < 15) return out;
  var trs = [];
  for (var i = 1; i < n; i++) {
    var c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  var atr = 0;
  for (var j = 0; j < 14; j++) atr += trs[j];
  atr = atr / 14;
  out[14] = atr;
  for (var m = 15; m < n; m++) { atr = (atr * 13 + trs[m-1]) / 14; out[m] = atr; }
  return out;
}
// Returns {analytic, clips}. `analytic` is a parallel array: the raw candle OBJECT for every
// unclipped bar (shared, never written to) and a fresh copy carrying wickClipped:true for a clipped
// one. Bar i is judged against the ATR14 as of bar i-1 (excluding its own true range, so a spike
// cannot mask itself) - a bar with no ATR yet (i-1 < 14) is never clipped. The clip never
// lengthens a wick: analytic low = max(raw low, min(open,close) - F3_CLIP_ATR_MULT*ATR), applied only
// when that is above the raw low (mirror for the high). Only bars at or after `fromIdx` (the fit
// window's start, full-series index space) are examined. `clips` lists one entry per clipped SIDE.
function applyWickClip(candles, fromIdx) {
  var n = candles.length, atrS = atr14Series(candles), analytic = candles.slice(), clips = [];
  for (var i = Math.max(fromIdx || 0, 1); i < n; i++) {
    var a = atrS[i-1];
    if (a == null) continue;
    var c = candles[i], aLow = c.low, aHigh = c.high, clipLow = false, clipHigh = false;
    if (c.low < c.close - F3_WICK_ATR_MULT * a) {
      var t = Math.max(c.low, Math.min(c.open, c.close) - F3_CLIP_ATR_MULT * a);
      if (t > c.low) { aLow = t; clipLow = true; }
    }
    if (c.high > c.close + F3_WICK_ATR_MULT * a) {
      var u = Math.min(c.high, Math.max(c.open, c.close) + F3_CLIP_ATR_MULT * a);
      if (u < c.high) { aHigh = u; clipHigh = true; }
    }
    if (!clipLow && !clipHigh) continue;
    var ac = Object.assign({}, c);
    ac.low = aLow; ac.high = aHigh; ac.wickClipped = true;
    analytic[i] = ac;
    if (clipLow) clips.push({idx:i, time:c.time, side:'low', raw:c.low, clippedTo:aLow, atr:a});
    if (clipHigh) clips.push({idx:i, time:c.time, side:'high', raw:c.high, clippedTo:aHigh, atr:a});
  }
  return {analytic:analytic, clips:clips};
}

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
  // F3: which array each read below uses - structural reads of a bar's low/high (pivot selection,
  // the pivot's recorded price, containment) use the ANALYTIC copy `aCandles`; everything else
  // (ATR14, tol, ema, patterns, rocket, breaks/lifecycle, the fit's own `candles`) reads the RAW
  // `candles`. meta._noWickClip (harness only, never set by capture.js or the page) skips the clip
  // so the runner gets its OLD reading from this same function.
  var clipRes = meta._noWickClip ? null : applyWickClip(candles, n > windowSize ? n - windowSize : 0);
  var aCandles = clipRes ? clipRes.analytic : candles;
  var pv = findPivotsWindowed(aCandles, windowSize); // analytic: pivot selection + pivot price
  var highs = pv.highs, lows = pv.lows;
  // H3: meta._h3Exclude ({side, idx}, internal to this function's own re-fit below) drops one pivot.
  if (meta._h3Exclude) {
    var h3x = meta._h3Exclude;
    if (h3x.side === 'low') lows = lows.filter(function(pt){ return pt.idx !== h3x.idx; });
    else highs = highs.filter(function(pt){ return pt.idx !== h3x.idx; });
  }
  if (lows.length < 3 || highs.length < 1) return null;

  var price = candles[n-1].close;
  var tol = computeResearchTol(candles, price); // raw candles (F3: tol keeps the end-of-series ATR)
  var atr = atr14(candles);                     // raw candles

  var ema = emaState(candles);
  // E3 (Remediation spec, 2026-09-21/22): research-only sibling, reusing this same `atr`
  // (computed just above) - flag-off's own bullEngulfing(candles) call, in detectChannel
  // below, is untouched.
  var conf = {bb3:bb3Reversion(candles), bullEngulf:bullEngulfingResearch(candles, atr), threeInsideUp:threeInsideUpResearch(candles),
    bb3UpperReversion:bb3UpperReversion(candles), threeInsideDown:threeInsideDown(candles)};
  // E6 (Remediation spec, 2026-09-21/22): candle-level fact, not tied to any one rail-pair
  // candidate, so computed once here - before the rail-pair loop - and read by every
  // candidate's patternBonus below exactly the way patternN already reads conf today.
  // `rocket` isn't known yet (it needs the winning rail); the check is extended with it once
  // the winner is chosen, at the same point rocket/multi are computed below.
  var patternConflict = signalConflict([conf.bullEngulf, conf.threeInsideUp], [conf.bb3UpperReversion, conf.threeInsideDown]);

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

      var winCandles = aCandles.slice(firstIdx); // F3: fit-window length (containment in _noD mode judges a clipped bar at its ANALYTIC low/high)
      var inside = 0, containment;
      if (meta._noD) {
        for (var i=0; i<winCandles.length; i++) {
          var ci = firstIdx+i;
          var s = railAt(slope,intercept,ci);
          var r2 = railAt(resSlope,resIntercept,ci); // R3: both rails checked per bar, generalizes the old flat s+channelH
          if (winCandles[i].low >= s*(1-tol) && winCandles[i].high <= r2*(1+tol)) inside++;
        }
        containment = (inside/winCandles.length)*100;
        if (containment < 55) continue;
      } else {
        // Step 10 D: containment for the SCORE and the eligibility gate is measured on bar CLOSES (RAW candles;
        // a close is identical in the raw and analytic copies), same tol bands and both-rails-per-bar geometry.
        // The F3 analytic low/high containment above is now unused for score and gate (kept for _noD, for
        // aCandles' other readers: pivots, containmentRecent, the H3 re-fit).
        for (var ic=firstIdx; ic<=lastIdx; ic++) {
          var sC = railAt(slope,intercept,ic);
          var rC = railAt(resSlope,resIntercept,ic);
          if (candles[ic].close >= sC*(1-tol) && candles[ic].close <= rC*(1+tol)) inside++;
        }
        containment = (inside/winCandles.length)*100;
        if (containment < D_CONT_GATE) continue;
      }
      if (pairLogEntry) pairLogEntry.reached = 'containment';

      if (position > 0.75) continue;
      if (pairLogEntry) pairLogEntry.reached = 'position';

      // A1/H9
      // F3: breaks and lifecycle are close-based and read the RAW candles.
      var scan = scanBreaks(candles, slope, intercept, firstIdx, lastIdx, tol, !meta._noD);
      var lifecycle = computeLifecycle(scan, supTouches, candles, slope, intercept, lastIdx, tol, RECLAIM_BARS);

      var slopePct = (slope / Math.abs(railAt(slope,intercept,firstIdx)||1)) * 100;
      var invalidation = supNow * (1-tol);

      var score = 0, scoreBreakdown = null, ema50Slope = null;
      var patternN = (conf.bb3.hit?1:0) + (conf.bullEngulf.hit?1:0) + (conf.threeInsideUp.hit?1:0);
      var sa = Math.abs(slopePct);
      if (meta._noD) {
        // Step 10 D: meta._noD (harness only, never set by capture.js or the page) runs the PRE-D research block
        // verbatim, so the runner's OLD derives from this same function (the _noWickClip pattern).
        score += Math.min(25, supTouches.length*8);
        score += Math.min(15, resTouches.length*6);
        score += (containment/100)*20;
        if(slope >= 0) { score += sa>=0.05&&sa<=3?15:sa<0.05?8:Math.max(0,15-(sa-3)*3); }
        else { score += Math.max(0, 8-(sa*3)); }
        score += position<=0.33?10:position<=0.5?6:position<=0.66?3:0;
        score += Math.min(6, winCandles.length/20);
        if(sa > 5) score -= 10;
        if(slope < 0) score -= 5;
        score += ema.pts;
        // E6: patternBonus excluded from score when the candle-level pattern conflict is present.
        var patternBonus = (patternN > 0 && !patternConflict) ? (2*patternN - 1) : 0;
        score += patternBonus;
        score = Math.round(clamp(score,0,100));
      } else {
        // Step 10 D. Read sources per component: everything below reads RAW candles / fit locals; the F3 analytic
        // copy is not consulted by the score (containment above is on raw closes).
        var dSlopePts = 0;
        if (slope >= 0) { dSlopePts = sa>=0.05&&sa<=3?15:sa<0.05?8:Math.max(0,15-(sa-3)*3); }
        else { dSlopePts = Math.max(0, 8-(sa*3)); }
        var dTouch = D_TOUCH_PTS[clamp(supTouches.length,2,7)-2];
        var dRes = D_RES_PTS[Math.min(resTouches.length,3)];
        if (resistanceFit === 'parallel') dRes = Math.min(dRes, D_RES_PARALLEL_MAX);
        var dCont = clamp((containment - D_CONT_GATE) / (100 - D_CONT_GATE) * D_CONT_MAX, 0, D_CONT_MAX);
        var dPos = (distToRailPct <= Math.min(D_POS_MULT[0]*tol, D_POS_FULL_CAP)) ? D_POS_PTS[0]
          : (distToRailPct <= D_POS_MULT[1]*tol) ? D_POS_PTS[1] : D_POS_PTS[2];
        var ageR = (timeframe === '4d-grid') ? D_AGE_RANGE_GRID : D_AGE_RANGE, ageBars = winCandles.length, dAge;
        if (ageBars > ageR[2] || ageBars <= ageR[0]) dAge = 0;
        else if (ageBars >= ageR[1]) dAge = D_AGE_MAX;
        else dAge = D_AGE_MAX * (ageBars - ageR[0]) / (ageR[1] - ageR[0]);
        // ema50Slope (C1's definition): (ema50[n-1] - ema50[n-1-N]) / ema50[n-1-N]. emaLast over a prefix is the same
        // fold, so it is bitwise the series value at that index. null when there are <= N closes or a non-positive base.
        if (n > D_EMA_SLOPE_BARS) {
          var e50Prev = emaLast(candles.slice(0, n - D_EMA_SLOPE_BARS).map(function(c){return c.close;}), 50);
          if (e50Prev > 0) ema50Slope = (ema.e50 - e50Prev) / e50Prev;
        }
        var dEmaSlope = (ema50Slope !== null && ema50Slope > 0) ? D_EMA_SLOPE_BONUS : 0;
        // Pattern bonus: 1D only; E6 conflict already excluded via patternConflict; shape 1/3/3.
        var dPattern = (timeframe === '1d' && patternN > 0 && !patternConflict) ? Math.min(D_PATTERN_MAX, 2*patternN - 1) : 0;
        // Volume on the most recent support touch bar vs the mean of the D_VOL_WINDOW bars before it (exclusive).
        // Missing / non-finite / non-positive volume in any of those bars, or too few prior bars -> 0, never a throw.
        var dVol = 0, volTouch = null;
        var tIdx = -1; for (var vt=0; vt<supTouches.length; vt++) if (supTouches[vt].idx > tIdx) tIdx = supTouches[vt].idx;
        if (tIdx >= D_VOL_WINDOW) {
          var vTouch = candles[tIdx].volume, vSum = 0, vOk = (typeof vTouch === 'number' && isFinite(vTouch) && vTouch > 0);
          for (var vk=tIdx-D_VOL_WINDOW; vOk && vk<tIdx; vk++) {
            var vv = candles[vk].volume;
            if (typeof vv === 'number' && isFinite(vv) && vv > 0) vSum += vv; else vOk = false;
          }
          if (vOk) { var vMean = vSum / D_VOL_WINDOW; volTouch = {idx:tIdx, volume:vTouch, mean20:vMean, ratio:vTouch / vMean}; if (vTouch >= D_VOL_TOUCH_MULT * vMean) dVol = D_VOL_TOUCH_BONUS; }
        }
        var dBreak = D_BREAK_PENALTY * scan.runCount2;
        var widthFrac = channelH / curPrice, dWidth = widthFrac > D_WIDTH_FRAC[1] ? D_WIDTH_PENALTY[1] : widthFrac > D_WIDTH_FRAC[0] ? D_WIDTH_PENALTY[0] : 0;
        var dSlopeSteep = sa > 5 ? 10 : 0, dSlopeNeg = slope < 0 ? 5 : 0;
        var rawPositive = dTouch + dRes + dCont + dSlopePts + dPos + dAge + ema.pts + dEmaSlope + dPattern + dVol;
        var rescaled = rawPositive * 100 / D_RAW_MAX; // the ONE rescale; penalties below are absolute points
        var penaltyTotal = dBreak + dWidth + dSlopeSteep + dSlopeNeg;
        score = Math.round(clamp(rescaled - penaltyTotal, 0, 100));
        scoreBreakdown = {touch:dTouch, res:dRes, cont:dCont, slope:dSlopePts, pos:dPos, age:dAge, ema:ema.pts, emaSlope:dEmaSlope,
          pattern:dPattern, vol:dVol, rawPositive:rawPositive, rescaled:rescaled,
          penalties:{brk:dBreak, width:dWidth, slopeSteep:dSlopeSteep, slopeNeg:dSlopeNeg}, penaltyTotal:penaltyTotal,
          final:score, runCount2:scan.runCount2, volTouch:volTouch};
      }

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
        containmentRecent: computeRecentContainment(aCandles, slope, intercept, channelH, firstIdx, lastIdx), // F3: containment -> ANALYTIC copy
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
      if (scoreBreakdown) { candidate.scoreBreakdown = scoreBreakdown; candidate.ema50Slope = ema50Slope; candidate.breakRunCount2 = scan.runCount2; } // Step 10 D (absent under _noD)

      if (eligible && (!bestEligible || candidate.score > bestEligible.score)) bestEligible = candidate;
      if (!bestAny || candidate.score > bestAny.score) bestAny = candidate;
    }
  }

  var winner = bestEligible || bestAny; // R1: eligible pair preferred; else best-scoring pair carries its ineligible state
  if (!winner) return null;

  var rocket = rocketAtSupportResearch(candles, winner.supSlope, winner.supIntercept, tol, atr, winner.lifecycleState);
  var bb3Coincidence = conf.bb3.hit ? {hit:true, idx:n-1, time:candles[n-1].time} : conf.bb3;
  var multi = multiSignalOnOneCandle([bb3Coincidence, conf.bullEngulf, conf.threeInsideUp, rocket]);
  winner.rocket = rocket.hit;
  winner.rocketTrigger = rocket;
  winner.multiSignal = multi.hit;
  winner.multiSignalTrigger = multi;

  // E6: extend the candle-level conflict with `rocket`, now that it's known (rail-dependent,
  // only available post-winner) - reuses patternConflict when bullEngulf/threeInsideUp already
  // found a conflicting pair, otherwise checks rocket alone against the same bearish set.
  var conflict = patternConflict || signalConflict([rocket], [conf.bb3UpperReversion, conf.threeInsideDown]);
  winner.conflictingSignals = !!conflict;
  winner.conflictingSignalsPair = conflict;

  // H11: one inspectable record per fired pattern (see buildPatternRecords above).
  winner.patternRecords = buildPatternRecords(candles, conf, rocket, conflict, meta, tol, winner.lifecycleState);

  // F3 / H3: every clipped bar in the fit window, one entry per clipped side, plus the H3 sensitivity
  // read: re-run this same fit with that pivot excluded and report the rail delta (percent, signed:
  // (without - with) / with * 100). Low side -> support rail (supportNow); high side -> resistance rail
  // (resistNow), only when the winner's resistance is an independent fit (B1) - a parallel resistance is
  // derived from the support line, so there is no separate pivot to exclude (reason 'parallel').
  // reason: null (computed) | 'not-pivot' | 'parallel' | 'no-fit-without-pivot' | 'no-base'.
  // Raw candles stay untouched: the entry carries raw and clippedTo, the analytic copy is never exposed.
  var wickClips = [];
  if (clipRes) {
    for (var wi = 0; wi < clipRes.clips.length; wi++) {
      var wc = clipRes.clips[wi];
      var isPivot = (wc.side === 'low' ? lows : highs).some(function(pt){ return pt.idx === wc.idx; });
      var wEntry = {idx:wc.idx, time:wc.time, side:wc.side, raw:wc.raw, clippedTo:wc.clippedTo, atr:wc.atr,
        pivot:isPivot, railDeltaPct:null, railUnchanged:null, reason:null};
      if (!isPivot) wEntry.reason = 'not-pivot';
      else if (wc.side === 'high' && winner.resistanceFit !== 'independent') wEntry.reason = 'parallel';
      else if (!meta._noH3) {
        var refit = detectChannelResearch(candles, null, Object.assign({}, meta, {_h3Exclude:{side:wc.side, idx:wc.idx}, _noH3:true}));
        var rBase = (wc.side === 'low') ? winner.supportNow : winner.resistNow;
        if (!refit) wEntry.reason = 'no-fit-without-pivot';
        else if (!(rBase > 0)) wEntry.reason = 'no-base';
        else {
          var rAlt = (wc.side === 'low') ? refit.supportNow : refit.resistNow;
          wEntry.railDeltaPct = (rAlt - rBase) / rBase * 100;
          wEntry.railUnchanged = Math.abs(wEntry.railDeltaPct) < F3_RAIL_UNCHANGED_PCT;
        }
      }
      wickClips.push(wEntry);
    }
  }
  winner.wickClips = wickClips;

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
    // E4 (Remediation spec, 2026-09-21/22) exports - constants for capture.js's configHash and
    // the function itself for direct harness testing.
    ROCKET_WICK_BODY: ROCKET_WICK_BODY, ROCKET_WICK_ATR: ROCKET_WICK_ATR,
    ROCKET_PRIOR_CLOSES_BELOW: ROCKET_PRIOR_CLOSES_BELOW,
    rocketAtSupportResearch: rocketAtSupportResearch,
    // E5 (Remediation spec, 2026-09-21/22) export - the function itself for direct harness testing (no new constants).
    threeInsideUpResearch: threeInsideUpResearch,
    // E6 (Remediation spec, 2026-09-21/22) export - the function itself for direct harness testing (no new constants).
    signalConflict: signalConflict,
    // Step 7 (Remediation spec, 2026-09-21/22) exports - constants for capture.js's configHash
    // and the B1 internals for direct harness testing.
    NEAR_FLAT_SLOPE_PCT: NEAR_FLAT_SLOPE_PCT, WEDGE_LOOKAHEAD: WEDGE_LOOKAHEAD,
    WEDGE_LOOKAHEAD_GRID: WEDGE_LOOKAHEAD_GRID, RES_RECENT_BARS: RES_RECENT_BARS,
    RES_RECENT_BARS_GRID: RES_RECENT_BARS_GRID,
    fitIndependentResistance: fitIndependentResistance, isWedge: isWedge,
    // H11 (Remediation spec, 2026-09-21/22) export - the function itself for direct harness testing (no new constants).
    buildPatternRecords: buildPatternRecords,
    // Step 9 F3/H3 (Remediation spec, 2026-09-21/22) exports - constants for capture.js's configHash and
    // the functions themselves for direct harness testing.
    F3_WICK_ATR_MULT: F3_WICK_ATR_MULT, F3_CLIP_ATR_MULT: F3_CLIP_ATR_MULT, F3_RAIL_UNCHANGED_PCT: F3_RAIL_UNCHANGED_PCT,
    applyWickClip: applyWickClip, atr14Series: atr14Series,
    // Step 10 D (Remediation spec Plan D) exports - constants for capture.js's configHash and the harness.
    D_TOUCH_PTS: D_TOUCH_PTS, D_RES_PTS: D_RES_PTS, D_RES_PARALLEL_MAX: D_RES_PARALLEL_MAX, D_CONT_GATE: D_CONT_GATE,
    D_CONT_MAX: D_CONT_MAX, D_BREAK_PENALTY: D_BREAK_PENALTY, D_POS_MULT: D_POS_MULT, D_POS_FULL_CAP: D_POS_FULL_CAP,
    D_POS_PTS: D_POS_PTS, D_AGE_RANGE: D_AGE_RANGE, D_AGE_RANGE_GRID: D_AGE_RANGE_GRID, D_AGE_MAX: D_AGE_MAX,
    D_WIDTH_FRAC: D_WIDTH_FRAC, D_WIDTH_PENALTY: D_WIDTH_PENALTY, D_EMA_SLOPE_BONUS: D_EMA_SLOPE_BONUS,
    D_EMA_SLOPE_BARS: D_EMA_SLOPE_BARS, D_PATTERN_MAX: D_PATTERN_MAX, D_VOL_TOUCH_BONUS: D_VOL_TOUCH_BONUS,
    D_VOL_TOUCH_MULT: D_VOL_TOUCH_MULT, D_VOL_WINDOW: D_VOL_WINDOW, D_RAW_MAX: D_RAW_MAX,
    // Step 11-A (Remediation spec Plan C / Verdict sequence) exports - constants for capture.js's configHash and the
    // verdict engine + helpers for the page (globals in the browser) and the harness.
    C1_EMA_SLOPE_MIN: C1_EMA_SLOPE_MIN, C3_FRESH_BARS: C3_FRESH_BARS, C3_FRESH_BARS_GRID: C3_FRESH_BARS_GRID,
    ACT_WIDTH_MAX: ACT_WIDTH_MAX, C2_DIST_TOL_MULT: C2_DIST_TOL_MULT, C2_DIST_CAP: C2_DIST_CAP,
    C4_VOLUME24H_MIN: C4_VOLUME24H_MIN, C4_VOL_TOUCH_MIN: C4_VOL_TOUCH_MIN, C5_BTC_SLOPE_MIN: C5_BTC_SLOPE_MIN,
    C6_SPIKE_BARS: C6_SPIKE_BARS, C6_SPIKE_ATR_MULT: C6_SPIKE_ATR_MULT, H6_RR_MIN: H6_RR_MIN,
    ACT_SCORE_FLOOR_1D: ACT_SCORE_FLOOR_1D, ACT_SCORE_FLOOR_GRID: ACT_SCORE_FLOOR_GRID,
    structureLabelOf: structureLabelOf, btcRegimeFromCandles: btcRegimeFromCandles, researchVerdict: researchVerdict
  };
}
