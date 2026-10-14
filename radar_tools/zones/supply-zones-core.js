/* supply-zones-core.js — "historical supply zones v1" (pinned). Pure functions, UMD, no fetch, no DOM.
 *
 * PINNED SOURCE (Ryan's decision 2026-10-14: we pin a public definition and label the layer as ours; we do not reverse-engineer a third party's indicator)
 *   script   : "Order Block Detector [LuxAlgo]" (TradingView, OPEN-SOURCE SCRIPT, Pine //@version=5)
 *   author   : LuxAlgo
 *   url      : https://www.tradingview.com/script/KvGhxGxY-Order-Block-Detector-LuxAlgo/
 *   updated  : Mar 10, 2023 (the page shows no further version number; the script has no version string)
 *   license  : the source is marked CC BY-NC-SA 4.0 (Attribution-NonCommercial-ShareAlike); this module is a derivative port of the BEARISH-block logic. Attribution is carried here and in the UI label.
 *   source sha256 (the displayed source text, gutter line numbers removed, fetched in-page 2026-10-14): 9563ced646fa13fed127c3e1f37a63e492251dd3ae64e13b4284d6c9792314dc
 *
 * SETTINGS FIXED AS v1 CONSTANTS (the script's own defaults, read from its inputs): Volume Pivot Length = 5; Mitigation Methods = 'Wick'. Bullish blocks are NOT implemented (demand zones = backlog).
 *
 * PORTED LOGIC (script -> here), per closed candle t (index in the closed series):
 *   upper(t) = highest high of candles t-4..t ; lower(t) = lowest low of t-4..t               (ta.highest / ta.lowest, length 5, current candle included)
 *   os(t)    = high[t-5] > upper(t) ? 0 : low[t-5] < lower(t) ? 1 : os(t-1)                    (os starts at 0, bearish; undefined comparisons while fewer than 5/6 candles exist fall through to os(t-1))
 *   phv(t)   = ta.pivothigh(volume, 5, 5): the volume of candle t-5 is greater than the volume of the 5 candles before it and the 5 after it (candles t-10..t)
 *   bearish zone when phv(t) and os(t) == 0:  top = high[t-5]; bottom = hl2[t-5] = (high+low)/2; reference line = (top+bottom)/2 ("geometric midpoint"); origin = candle t-5
 *   mitigation (Wick): target(t) = highest high of t-4..t; every active zone with target(t) > top is removed at candle t. ('Close' = highest close; supported by the function, not used by v1.)
 *   The zone is created before the mitigation test of the same candle, as in the script.
 *
 * WHERE THIS DIFFERS FROM THE SCRIPT (stated, not hidden)
 *   1. Drawing: the script draws a box from the ORIGIN candle (extend right) and keeps the newest three. v1 stores originTime AND confirmedAt (close of candle t, the last candle the pivot needed) and the page draws from confirmedAt only, with a marker at the origin candle; the display limit is the page's own selection rule, not the script's "last 3".
 *   2. Mitigation loop: the script removes elements inside a for-in over the same array; v1 applies the evident intent (every zone whose top is below the target is removed on that candle). If Pine skips an element after a removal, TradingView can show such a zone for up to four more candles; v1 does not.
 *   3. Ties: the Pine reference does not state how equal volumes are treated in ta.pivothigh. v1 requires the pivot volume to be STRICTLY greater than all ten neighbours (a tie yields no pivot).
 *   4. Only CLOSED candles are used (candle.time + intervalSec <= nowMs/1000); the forming candle never confirms or invalidates anything.
 *   5. A pivot window that touches a candle without a finite volume cannot be a pivot; a series with no usable volume at all is reported unavailable ('volume'), never replaced by another venue's volume or book depth.
 * Candles: {time (UTC seconds, interval start), open, high, low, close, volume}. Results never depend on candles appended later (replay-safe): a zone's fields at candle t are a function of candles <= t only, except the series start, which fixes os's initial value (0) exactly as the script's first bar does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SupplyZonesCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DETECTOR = {
    id: 'historical supply zones v1', name: 'Order Block Detector [LuxAlgo]', version: 'Mar 10, 2023 (Pine v5)', pinned: true,
    url: 'https://www.tradingview.com/script/KvGhxGxY-Order-Block-Detector-LuxAlgo/', author: 'LuxAlgo', license: 'CC BY-NC-SA 4.0',
    sourceSha256: '9563ced646fa13fed127c3e1f37a63e492251dd3ae64e13b4284d6c9792314dc', pivotLength: 5, mitigation: 'wick', tie: 'strict'
  };
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function closedSeries(candles, intervalSec, nowMs) {
    var seen = {}, out = [];
    (candles || []).forEach(function (c) {
      if (!c || !isNum(c.time) || !isNum(c.high) || !isNum(c.low) || !isNum(c.open) || !isNum(c.close)) return;
      if (seen[c.time]) return; seen[c.time] = 1;
      if (isNum(nowMs) && (c.time + intervalSec) * 1000 > nowMs) return;   /* forming (or future) candle */
      out.push(c);
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  /* detectBearish(candles, { intervalSec, nowMs, mitigation }) ->
       { detector, available, reason, intervalSec, closedCount, firstTime, lastClosedTime, zones[] }
     zones[]: { id, originTime, confirmedAt, top, bottom, mid, volume, quoteEst, mitigatedAt, mitigatedBy, rule } — mitigated zones stay in the list with mitigatedAt. */
  function detectBearish(candles, opt) {
    opt = opt || {}; var L = DETECTOR.pivotLength, iv = isNum(opt.intervalSec) && opt.intervalSec > 0 ? opt.intervalSec : 86400, mit = opt.mitigation === 'close' ? 'close' : 'wick';
    var c = closedSeries(candles, iv, opt.nowMs), n = c.length;
    var res = { detector: DETECTOR, available: false, reason: null, intervalSec: iv, closedCount: n, firstTime: n ? c[0].time : null, lastClosedTime: n ? c[n - 1].time : null, zones: [] };
    if (n < 2 * L + 1) { res.reason = 'lookback'; return res; }
    var anyVol = false; for (var i = 0; i < n; i++) if (isNum(c[i].volume) && c[i].volume > 0) { anyVol = true; break; }
    if (!anyVol) { res.reason = 'volume'; return res; }
    res.available = true;
    var os = 0, active = [];
    for (var t = 0; t < n; t++) {
      var upper = null, lower = null, hcl = null;
      if (t >= L - 1) { upper = -Infinity; lower = Infinity; hcl = -Infinity; for (var k = t - L + 1; k <= t; k++) { if (c[k].high > upper) upper = c[k].high; if (c[k].low < lower) lower = c[k].low; if (c[k].close > hcl) hcl = c[k].close; } }
      if (t >= L && upper != null) { if (c[t - L].high > upper) os = 0; else if (c[t - L].low < lower) os = 1; }
      if (t >= 2 * L) {
        var p = c[t - L], v = p.volume, ok = isNum(v);
        for (var j = t - 2 * L; ok && j <= t; j++) { if (j === t - L) continue; var vj = c[j].volume; if (!isNum(vj) || !(v > vj)) ok = false; }
        if (ok && os === 0) {
          var top = p.high, bottom = (p.high + p.low) / 2;
          var z = { id: 'hs1-' + p.time, originTime: p.time, confirmedAt: c[t].time + iv, top: top, bottom: bottom, mid: (top + bottom) / 2, volume: v, quoteEst: isNum(p.close) ? p.close * v : null, mitigatedAt: null, mitigatedBy: null, rule: null };
          res.zones.push(z); active.push(z);
        }
      }
      if (upper != null && active.length) {
        var target = mit === 'close' ? hcl : upper;
        active = active.filter(function (z) { if (target > z.top) { z.mitigatedAt = c[t].time + iv; z.mitigatedBy = c[t].time; z.rule = mit; return false; } return true; });
      }
    }
    return res;
  }

  /* selectDisplay(zones, ctx) -> { mode, total, shown[], all[] }
       ctx: { E, T }  valid path (T > E > 0)  -> mode 'path': active zones whose range intersects (E, T], i.e. top > E and bottom < T
            { ref, vlo, vhi } no valid path    -> mode 'context': active zones above ref (the latest close) intersecting the viewport [vlo, vhi]
     shown = up to 3 nearest ordered by lower boundary (stable: originTime, then id); all = the same set price-ordered (the expandable list). */
  function selectDisplay(zones, ctx) {
    ctx = ctx || {}; var path = isNum(ctx.E) && isNum(ctx.T) && ctx.E > 0 && ctx.T > ctx.E, set;
    var act = (zones || []).filter(function (z) { return z.mitigatedAt == null; });
    if (path) set = act.filter(function (z) { return z.top > ctx.E && z.bottom < ctx.T; });
    else if (isNum(ctx.vlo) && isNum(ctx.vhi)) set = act.filter(function (z) { return z.top > ctx.vlo && z.bottom < ctx.vhi && (!isNum(ctx.ref) || z.top > ctx.ref); });
    else set = [];
    set = set.slice().sort(function (a, b) { return (a.bottom - b.bottom) || (a.originTime - b.originTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return { mode: path ? 'path' : 'context', total: set.length, shown: set.slice(0, 3), all: set };
  }

  return { DETECTOR: DETECTOR, detectBearish: detectBearish, selectDisplay: selectDisplay, closedSeries: closedSeries };
});
