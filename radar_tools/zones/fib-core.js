/* fib-core.js — "fib impulse leg v1" (item 52n part C). Pure functions, UMD, no fetch, no DOM. Descriptive geometry only: no score, no probability, no "take profit here".
 *
 * IMPULSE LEG (pinned v1), on the chart's CLOSED candles (the page passes the daily series):
 *   price pivot low  at i : low[i]  is STRICTLY less    than the lows  of the 5 candles before and the 5 after (same length 5 and strict-tie rule as the 52j port; price pivots, not volume)
 *   price pivot high at i : high[i] is STRICTLY greater than the highs of the 5 candles before and the 5 after
 *   a pivot is CONFIRMED only once candle i+5 has closed (confirmedAt = close of candle i+5); the forming candle never confirms.
 *   leg = the most recent confirmed pivot low L, then the highest high among confirmed pivot highs that occur AFTER L (earliest on a tie). If no confirmed pivot high follows the most recent confirmed
 *   pivot low (or there is no confirmed pivot low) -> status 'unavailable', reason 'no confirmed impulse'. Bullish legs only in v1 (bearish legs = backlog).
 *   leg.confirmedAt = the later of the two pivots' confirmation times. Results depend on closed candles up to that time only.
 * LEVELS (range = high - low): retracements 0.618 / 0.705 / 0.786 -> price = high - r*range ; extensions 1.272 / 1.618 -> price = low + e*range ; reference 0 (= high) and 1 (= low).
 * CONFLUENCE: for each level, every item whose price range intersects [price*(1-tol), price*(1+tol)] (tol = 1 %, inclusive): entry zone, stop S, target T, demand boxes, supply boxes, current sell-liquidity zones (venue, $).
 *   Items are listed, never scored. Inputs are read, never modified.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FibCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var L = 5, RETR = [0.618, 0.705, 0.786], EXT = [1.272, 1.618];
  var DEF = { id: 'fib impulse leg v1', pivotLength: L, tie: 'strict', retracements: RETR, extensions: EXT, tolerance: 0.01 };
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function closed(candles, iv, nowMs) {
    var seen = {}, out = [];
    (candles || []).forEach(function (c) {
      if (!c || !isNum(c.time) || !isNum(c.high) || !isNum(c.low)) return;
      if (seen[c.time]) return; seen[c.time] = 1;
      if (isNum(nowMs) && (c.time + iv) * 1000 > nowMs) return;
      out.push(c);
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }
  /* pivots(c) -> { lows[], highs[] } each { idx, time, price, confirmedAt } ; confirmedAt is set by the caller's interval */
  function pivots(c, iv) {
    var lows = [], highs = [], n = c.length;
    for (var i = L; i + L < n; i++) {
      var lo = true, hi = true;
      for (var j = i - L; j <= i + L; j++) { if (j === i) continue; if (!(c[i].low < c[j].low)) lo = false; if (!(c[i].high > c[j].high)) hi = false; if (!lo && !hi) break; }
      if (lo) lows.push({ idx: i, time: c[i].time, price: c[i].low, confirmedAt: c[i + L].time + iv });
      if (hi) highs.push({ idx: i, time: c[i].time, price: c[i].high, confirmedAt: c[i + L].time + iv });
    }
    return { lows: lows, highs: highs };
  }
  function impulseLeg(candles, opt) {
    opt = opt || {}; var iv = isNum(opt.intervalSec) && opt.intervalSec > 0 ? opt.intervalSec : 86400, c = closed(candles, iv, opt.nowMs);
    if (c.length < 2 * L + 1) return { available: false, reason: 'lookback', leg: null };
    var p = pivots(c, iv);
    if (!p.lows.length) return { available: false, reason: 'no confirmed impulse', leg: null };
    var low = p.lows[p.lows.length - 1], best = null;
    p.highs.forEach(function (h) { if (h.idx > low.idx && (best == null || h.price > best.price)) best = h; });
    if (!best) return { available: false, reason: 'no confirmed impulse', leg: null };
    return { available: true, reason: null, leg: { lowTime: low.time, low: low.price, highTime: best.time, high: best.price, confirmedAt: Math.max(low.confirmedAt, best.confirmedAt) } };
  }
  function levelsFor(leg) {
    var r = leg.high - leg.low, out = [{ ratio: 0, kind: 'ref', price: leg.high }];
    RETR.forEach(function (x) { out.push({ ratio: x, kind: 'retracement', price: leg.high - x * r }); });
    out.push({ ratio: 1, kind: 'ref', price: leg.low });
    EXT.forEach(function (x) { out.push({ ratio: x, kind: 'extension', price: leg.low + x * r }); });
    return out;
  }
  /* items: normalised list [{ kind:'entry'|'stop'|'target'|'demand'|'supply'|'sell', id, lo, hi, venue?, usd? }] */
  function normaliseItems(ctx) {
    ctx = ctx || {}; var it = [];
    if (ctx.entry && isNum(ctx.entry.low) && isNum(ctx.entry.high)) it.push({ kind: 'entry', id: 'E', lo: Math.min(ctx.entry.low, ctx.entry.high), hi: Math.max(ctx.entry.low, ctx.entry.high) });
    if (isNum(ctx.stop)) it.push({ kind: 'stop', id: 'S', lo: ctx.stop, hi: ctx.stop });
    if (isNum(ctx.target)) it.push({ kind: 'target', id: 'T', lo: ctx.target, hi: ctx.target });
    (ctx.demand || []).forEach(function (z, i) { if (z && isNum(z.bottom) && isNum(z.top)) it.push({ kind: 'demand', id: z.label || ('D' + (i + 1)), zoneId: z.id || null, lo: z.bottom, hi: z.top }); });
    (ctx.supply || []).forEach(function (z, i) { if (z && isNum(z.bottom) && isNum(z.top)) it.push({ kind: 'supply', id: z.label || ('H' + (i + 1)), zoneId: z.id || null, lo: z.bottom, hi: z.top }); });
    (ctx.sell || []).forEach(function (z, i) { if (z && isNum(z.lo) && isNum(z.hi)) it.push({ kind: 'sell', id: z.label || ('A' + (i + 1)), venue: z.venue || null, usd: isNum(z.usd) ? z.usd : null, txt: typeof z.txt === 'string' ? z.txt : null, lo: z.lo, hi: z.hi }); });
    return it;
  }
  /* compute(candles, opt, ctx) -> { detector, status, reason, leg, levels[{ratio,kind,price,confluence[]}] }
       opt: { intervalSec, nowMs } ; ctx: { entry:{low,high}, stop, target, demand:[{top,bottom,id,label}], supply:[...], sell:[{lo,hi,venue,usd,label}] } */
  function compute(candles, opt, ctx) {
    var r = impulseLeg(candles, opt), res = { detector: DEF, status: r.available ? 'ok' : 'unavailable', reason: r.reason, leg: r.leg, levels: [] };
    if (!r.available) return res;
    var items = normaliseItems(ctx), tol = DEF.tolerance;
    res.levels = levelsFor(r.leg).map(function (lv) {
      var a = lv.price * (1 - tol), b = lv.price * (1 + tol);
      lv.confluence = items.filter(function (x) { return x.hi >= a && x.lo <= b; }).map(function (x) { var o = {}; for (var k in x) o[k] = x[k]; return o; });
      return lv;
    });
    return res;
  }
  return { DEF: DEF, compute: compute, impulseLeg: impulseLeg, levelsFor: levelsFor, pivots: pivots, closed: closed };
});
