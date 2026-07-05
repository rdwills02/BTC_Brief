/* channel-geo.js — GEOMETRY-ONLY channel detection for the research / history layer.
 *
 * This is deliberately SEPARATE from channel-core.detectChannel (the live-radar detector).
 * The live detector scores and gates channels for entry-signal prioritization: it's
 * ascending-only, has a position gate, EMA/BB/candle confluence, and a 0-100 score whose
 * only purpose is ranking which live coins a human evaluates first.
 *
 * The history layer needs none of that. It catalogs a coin's channels for visual comparison,
 * so it wants: find rail-respecting channels of ANY direction (asc/desc/flat), describe their
 * geometry (rails, slope, height, containment, touches, duration, run), and nothing else —
 * no score, no direction gate, no entry-timing gate.
 *
 * Reuses channel-core's math primitives (findPivots, railAt, TOUCH_TOL, PIVOT_LB) so pivot/rail
 * detection stays identical to the live system; only the gating/scoring pipeline differs.
 * This keeps live radar completely untouched.
 *
 * detectChannelGeo(candles) -> best geometric channel ending at the last candle, or null.
 * Shape mirrors detectChannel's geometry fields (so downstream code / tiles work unchanged),
 * minus score/emaState/confluence.
 */

(function(root){
  var C = (typeof require !== 'undefined') ? require('./channel-core.js') : root;
  var TOUCH_TOL = C.TOUCH_TOL;      // same tolerance as live (0.025)
  var MIN_TOUCHES = 3;              // structure requirement: a channel needs >=3 support touches
  var CONTAIN_FLOOR = 0.55;         // describe-not-gate, but reject clearly non-channel fits

  function detectChannelGeo(candles) {
    if (!candles || candles.length < 2 * C.PIVOT_LB + 3) return null;
    var piv = C.findPivots(candles);
    var lows = piv.lows, highs = piv.highs;
    if (lows.length < 2) return null;

    var n = candles.length, lastIdx = n - 1;
    var best = null, bestContain = -1;

    // Try every pair of pivot lows as the support rail (ANY slope — no direction gate).
    for (var i = 0; i < lows.length; i++) {
      for (var k = i + 1; k < lows.length; k++) {
        var p1 = lows[i], p2 = lows[k];
        var idxDelta = p2.idx - p1.idx;
        if (idxDelta < 3) continue;

        var slope = (p2.price - p1.price) / idxDelta;      // ANY slope allowed
        var intercept = p1.price - slope * p1.idx;

        // support touches within tolerance of the rail
        var supTouches = lows.filter(function(l) {
          var exp = C.railAt(slope, intercept, l.idx);
          return exp > 0 && Math.abs(l.price - exp) / exp <= TOUCH_TOL;
        });
        if (supTouches.length < MIN_TOUCHES) continue;

        var firstIdx = Math.min.apply(null, supTouches.map(function(l){return l.idx;}));

        // resistance rail = parallel line at the max high-distance above support, over the span
        var relHighs = highs.filter(function(h){ return h.idx >= firstIdx; });
        var channelH = 0;
        for (var h = 0; h < relHighs.length; h++) {
          var d = relHighs[h].price - C.railAt(slope, intercept, relHighs[h].idx);
          if (d > channelH) channelH = d;
        }
        if (channelH <= 0) continue;

        // resistance touches (near the top rail)
        var resTouches = highs.filter(function(hh){
          if (hh.idx < firstIdx) return false;
          var expTop = C.railAt(slope, intercept, hh.idx) + channelH;
          return expTop > 0 && Math.abs(hh.price - expTop) / expTop <= TOUCH_TOL;
        });

        // containment: fraction of candles in the span that sit inside the band
        var winCandles = candles.slice(firstIdx);
        var inside = 0;
        for (var w = 0; w < winCandles.length; w++) {
          var ci = firstIdx + w;
          var lo = C.railAt(slope, intercept, ci);
          var hi = lo + channelH;
          var c = winCandles[w];
          if (c.low >= lo - channelH * 0.15 && c.high <= hi + channelH * 0.15) inside++;
        }
        var containment = winCandles.length ? inside / winCandles.length : 0;
        if (containment < CONTAIN_FLOOR) continue;

        // keep the best-contained channel (containment is the descriptive quality proxy here,
        // NOT a rank the human acts on — just picks the cleanest fit ending at lastIdx)
        if (containment > bestContain) {
          bestContain = containment;
          var slopePct = (slope / Math.abs(C.railAt(slope, intercept, firstIdx) || 1)) * 100;
          var supNow = C.railAt(slope, intercept, lastIdx);
          best = {
            supSlope: slope, supIntercept: intercept, channelH: channelH,
            slope: slopePct,
            supportTouches: supTouches.length, resTouches: resTouches.length,
            containment: Math.round(containment * 100),
            firstIdx: firstIdx, lastIdx: lastIdx,
            supportNow: supNow, resistNow: supNow + channelH,
            invalidation: supNow - channelH * 0.15,
            isAscending: slope > 0, isFlat: Math.abs(slopePct) < 0.1,
            position: C.clamp((candles[lastIdx].close - supNow) / (channelH || 1), 0, 1),
            pivotLows: supTouches
          };
        }
      }
    }
    return best;
  }

  var api = { detectChannelGeo: detectChannelGeo, MIN_TOUCHES: MIN_TOUCHES, CONTAIN_FLOOR: CONTAIN_FLOOR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.detectChannelGeo = detectChannelGeo; }
})(typeof self !== 'undefined' ? self : this);
