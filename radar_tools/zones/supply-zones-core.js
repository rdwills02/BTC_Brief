/* supply-zones-core.js — "historical supply zones v1" (pinned). Pure functions, UMD, no fetch, no DOM.
 *
 * PINNED SOURCE (Ryan's decision 2026-10-14: we pin a public definition and label the layer as ours; we do not reverse-engineer a third party's indicator)
 *   script   : "Order Block Detector [LuxAlgo]" (TradingView, OPEN-SOURCE SCRIPT, Pine //@version=5)
 *   author   : LuxAlgo
 *   url      : https://www.tradingview.com/script/KvGhxGxY-Order-Block-Detector-LuxAlgo/
 *   updated  : Mar 10, 2023 (the page shows no further version number; the script has no version string)
 *   license  : the source is marked CC BY-NC-SA 4.0 (Attribution-NonCommercial-ShareAlike); this module is a derivative port of the BEARISH-block logic (52j) and the BULLISH-block logic (52n). Attribution is carried here and in the UI label.
 *   reference text: third-party/order-block-detector-luxalgo.pine.txt, sha256 e095c9513be0936a19919866abfb1b8e10b51539105169533b9e601669363a10 (an earlier 9563ced6… value recorded 2026-10-14 is historical and unreproduced)
 *
 * SETTINGS FIXED AS v1 CONSTANTS (the script's own defaults, read from its inputs): Volume Pivot Length = 5; Mitigation Methods = 'Wick'. Bullish blocks are implemented from 52n (see BULLISH PORT below).
 *
 * BULLISH PORT (item 52n; verified against the pinned source text in-page 2026-10-14): the script uses the SAME volume pivot HIGH (phv = ta.pivothigh(volume, 5, 5)) for both sides; the side is chosen by os.
 *   bullish zone when phv(t) and os(t) == 1: top = hl2[t-5] = (high+low)/2 ; bottom = low[t-5] ; reference line = (top+bottom)/2 ; origin = candle t-5
 *   mitigation (Wick): target(t) = lowest low of t-4..t; every active bullish zone with target(t) < bottom is removed at candle t. ('Close' = lowest close.)
 *   The same differences 1-5 below apply unchanged (confirmedAt, no look-ahead, strict ties, closed candles only, volume availability). detectBearish output is unchanged from 52j.
 * (The 52n build prompt said "volume pivot LOW"; the pinned script does not use ta.pivotlow. The script's behaviour is what is ported.)
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
 *   6. (item 52p) A pivot window with a missing volume value is reported in result.unevaluable (with the window and the missing times); result.partialVolume is true and result.partialRanges holds the merged ranges. Zones that can be established are kept; "no zone" is not concluded for a partial range. Missing volume is never replaced by zero.
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
    sourceSha256: 'e095c9513be0936a19919866abfb1b8e10b51539105169533b9e601669363a10',
    sourceSha256Superseded: '9563ced646fa13fed127c3e1f37a63e492251dd3ae64e13b4284d6c9792314dc',   // recorded 2026-10-14, unreproduced; Astra ruling 2026-10-15
    pivotLength: 5, mitigation: 'wick', tie: 'strict'
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

  /* item 52p (B4): a pivot window with a missing/non-finite volume is NOT silently skipped. unevalWindow returns an entry when the window of candle t-L (candles t-2L..t) holds a missing volume AND the finite values do not already rule the pivot out (the candle's own volume is finite and strictly greater than every finite neighbour, or the candle's own volume is missing). Missing volume is never replaced by zero or another venue's value. */
  function unevalWindow(c, t, L, iv, side) {
    var p = c[t - L], v = p.volume, miss = [], ruledOut = false;
    for (var j = t - 2 * L; j <= t; j++) {
      var vj = c[j].volume;
      if (!isNum(vj)) { miss.push(c[j].time); continue; }
      if (j !== t - L && isNum(v) && !(v > vj)) ruledOut = true;
    }
    if (!miss.length || ruledOut) return null;
    return { originTime: p.time, side: side, windowFrom: c[t - 2 * L].time, windowTo: c[t].time + iv, confirmedAt: c[t].time + iv, missingVolumeTimes: miss, priceLow: p.low, priceHigh: p.high, reason: 'missing-volume' };   /* priceLow / priceHigh = the origin candle's range: where a zone from this pivot could lie */
  }
  function mergeRanges(list) {
    var r = list.map(function (u) { return { from: u.windowFrom, to: u.windowTo }; }).sort(function (a, b) { return a.from - b.from; }), out = [];
    r.forEach(function (x) { var l = out[out.length - 1]; if (l && x.from <= l.to) { if (x.to > l.to) l.to = x.to; } else out.push({ from: x.from, to: x.to }); });
    return out;
  }

  /* detectBearish(candles, { intervalSec, nowMs, mitigation }) ->
       { detector, available, reason, intervalSec, closedCount, firstTime, lastClosedTime, zones[] }
     zones[]: { id, originTime, confirmedAt, top, bottom, mid, volume, quoteEst, mitigatedAt, mitigatedBy, rule } — mitigated zones stay in the list with mitigatedAt. */
  function detectBearish(candles, opt) {
    opt = opt || {}; var L = DETECTOR.pivotLength, iv = isNum(opt.intervalSec) && opt.intervalSec > 0 ? opt.intervalSec : 86400, mit = opt.mitigation === 'close' ? 'close' : 'wick';
    var c = closedSeries(candles, iv, opt.nowMs), n = c.length;
    var res = { detector: DETECTOR, available: false, reason: null, intervalSec: iv, closedCount: n, firstTime: n ? c[0].time : null, lastClosedTime: n ? c[n - 1].time : null, zones: [], unevaluable: [], partialVolume: false, partialRanges: [] };
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
        } else if (!ok && os === 0) { var u0 = unevalWindow(c, t, L, iv, 'supply'); if (u0) res.unevaluable.push(u0); }
      }
      if (upper != null && active.length) {
        var target = mit === 'close' ? hcl : upper;
        active = active.filter(function (z) { if (target > z.top) { z.mitigatedAt = c[t].time + iv; z.mitigatedBy = c[t].time; z.rule = mit; return false; } return true; });
      }
    }
    res.partialVolume = res.unevaluable.length > 0; res.partialRanges = mergeRanges(res.unevaluable);
    return res;
  }

  /* detectBullish(candles, opt) -> same shape as detectBearish; zones[]: { id 'hd1-<originTime>', originTime, confirmedAt, top = hl2 of origin, bottom = low of origin, mid, volume, quoteEst, mitigatedAt, mitigatedBy, rule }. */
  function detectBullish(candles, opt) {
    opt = opt || {}; var L = DETECTOR.pivotLength, iv = isNum(opt.intervalSec) && opt.intervalSec > 0 ? opt.intervalSec : 86400, mit = opt.mitigation === 'close' ? 'close' : 'wick';
    var c = closedSeries(candles, iv, opt.nowMs), n = c.length;
    var res = { detector: DETECTOR, available: false, reason: null, intervalSec: iv, closedCount: n, firstTime: n ? c[0].time : null, lastClosedTime: n ? c[n - 1].time : null, zones: [], unevaluable: [], partialVolume: false, partialRanges: [] };
    if (n < 2 * L + 1) { res.reason = 'lookback'; return res; }
    var anyVol = false; for (var i = 0; i < n; i++) if (isNum(c[i].volume) && c[i].volume > 0) { anyVol = true; break; }
    if (!anyVol) { res.reason = 'volume'; return res; }
    res.available = true;
    var os = 0, active = [];
    for (var t = 0; t < n; t++) {
      var upper = null, lower = null, lcl = null;
      if (t >= L - 1) { upper = -Infinity; lower = Infinity; lcl = Infinity; for (var k = t - L + 1; k <= t; k++) { if (c[k].high > upper) upper = c[k].high; if (c[k].low < lower) lower = c[k].low; if (c[k].close < lcl) lcl = c[k].close; } }
      if (t >= L && upper != null) { if (c[t - L].high > upper) os = 0; else if (c[t - L].low < lower) os = 1; }
      if (t >= 2 * L) {
        var p = c[t - L], v = p.volume, ok = isNum(v);
        for (var j = t - 2 * L; ok && j <= t; j++) { if (j === t - L) continue; var vj = c[j].volume; if (!isNum(vj) || !(v > vj)) ok = false; }
        if (ok && os === 1) {
          var top = (p.high + p.low) / 2, bottom = p.low;
          var z = { id: 'hd1-' + p.time, originTime: p.time, confirmedAt: c[t].time + iv, top: top, bottom: bottom, mid: (top + bottom) / 2, volume: v, quoteEst: isNum(p.close) ? p.close * v : null, mitigatedAt: null, mitigatedBy: null, rule: null };
          res.zones.push(z); active.push(z);
        } else if (!ok && os === 1) { var u1 = unevalWindow(c, t, L, iv, 'demand'); if (u1) res.unevaluable.push(u1); }
      }
      if (lower != null && active.length) {
        var target = mit === 'close' ? lcl : lower;
        active = active.filter(function (z) { if (target < z.bottom) { z.mitigatedAt = c[t].time + iv; z.mitigatedBy = c[t].time; z.rule = mit; return false; } return true; });
      }
    }
    res.partialVolume = res.unevaluable.length > 0; res.partialRanges = mergeRanges(res.unevaluable);
    return res;
  }

  /* item 52p (B4): replayRecord(candles, res, meta) -> the record needed to replay a detection exactly. meta: { source, pair, intervalSec, rawInputSha256, asOfMs }. The first input timestamp is kept because the initial regime (os = 0) depends on the series start. Missing bars stay explicit (missingBarTimes), never treated as a contiguous calendar series. */
  function replayRecord(candles, res, meta) {
    meta = meta || {}; var iv = res && res.intervalSec ? res.intervalSec : (meta.intervalSec || 86400), asOf = meta.asOfMs;
    var seen = {}, dup = 0, forming = 0, bad = 0, times = [];
    (candles || []).forEach(function (c) {
      if (!c || !isNum(c.time) || !isNum(c.high) || !isNum(c.low) || !isNum(c.open) || !isNum(c.close)) { bad++; return; }
      if (seen[c.time]) { dup++; return; } seen[c.time] = 1;
      if (isNum(asOf) && (c.time + iv) * 1000 > asOf) { forming++; return; }
      times.push(c.time);
    });
    times.sort(function (a, b) { return a - b; });
    var missing = []; for (var i = 1; i < times.length; i++) for (var t = times[i - 1] + iv; t < times[i]; t += iv) missing.push(t);
    return {
      record: 'supply-zones-replay/1', source: meta.source || null, pair: meta.pair || null, intervalSec: iv,
      firstInputTime: times.length ? times[0] : null, lastClosedTime: times.length ? times[times.length - 1] : null, closedCount: times.length,
      rawInputSha256: meta.rawInputSha256 || null, asOfMs: isNum(asOf) ? asOf : null,
      formingBarExclusion: 'a candle is closed only when time + intervalSec <= asOf; ' + forming + ' excluded',
      missingDuplicatePolicy: 'duplicates: first occurrence kept (' + dup + ' dropped); non-finite OHLC dropped (' + bad + '); missing bars listed in missingBarTimes, not interpolated; missing volume is never zero-filled (see unevaluable)',
      missingBarTimes: missing,
      detector: { id: DETECTOR.id, sourceSha256: DETECTOR.sourceSha256, pivotLength: DETECTOR.pivotLength, mitigation: res && res.mitigation || DETECTOR.mitigation, tie: DETECTOR.tie },
      zones: ((res && res.zones) || []).map(function (z) { return { id: z.id, originTime: z.originTime, confirmedAt: z.confirmedAt, mitigatedAt: z.mitigatedAt }; }),
      unevaluable: ((res && res.unevaluable) || []).map(function (u) { return { originTime: u.originTime, side: u.side, windowFrom: u.windowFrom, windowTo: u.windowTo }; }),
      partialVolume: !!(res && res.partialVolume)
    };
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

  /* selectDemandDisplay(zones, ctx) -> { mode, total, shown[], all[] }  (demand mirror of selectDisplay; 52n)
       ctx: { S, T, ref }  valid path (T > S > 0) -> mode 'path': active zones whose range intersects [S, T] (top >= S and bottom <= T) and lie BELOW price (top < ref when ref is given)
            { ref, vlo, vhi } no valid path       -> mode 'context': active zones below ref intersecting the viewport [vlo, vhi]
     shown = up to 3 nearest below price, ordered by UPPER boundary descending (stable: originTime, then id); all = the same set (the expandable list). */
  function selectDemandDisplay(zones, ctx) {
    ctx = ctx || {}; var path = isNum(ctx.S) && isNum(ctx.T) && ctx.S > 0 && ctx.T > ctx.S, set;
    var act = (zones || []).filter(function (z) { return z.mitigatedAt == null; });
    var below = function (z) { return !isNum(ctx.ref) || z.top < ctx.ref; };
    if (path) set = act.filter(function (z) { return z.top >= ctx.S && z.bottom <= ctx.T && below(z); });
    else if (isNum(ctx.vlo) && isNum(ctx.vhi)) set = act.filter(function (z) { return z.top >= ctx.vlo && z.bottom <= ctx.vhi && below(z); });
    else set = [];
    set = set.slice().sort(function (a, b) { return (b.top - a.top) || (a.originTime - b.originTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return { mode: path ? 'path' : 'context', total: set.length, shown: set.slice(0, 3), all: set };
  }

  return { DETECTOR: DETECTOR, detectBearish: detectBearish, detectBullish: detectBullish, selectDemandDisplay: selectDemandDisplay, selectDisplay: selectDisplay, replayRecord: replayRecord, closedSeries: closedSeries };
});
