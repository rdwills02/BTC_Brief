/* radar_tools/book/book-codec.js — item 52b B: compact snapshot codec (schema 2 records <-> integer arrays). Pure functions, no I/O.
 * DECLARED FORMAT
 *  - Scale per pair (batch header): pd = decimals of the tick (price), bd = decimals of the lot (base size). Quote money uses 2 decimals (cents of the QUOTE currency; USD/USDC/USDT are never pooled).
 *  - price -> integer ticks = round(price * 10^pd); base -> integer units = round(base * 10^bd); quote -> integer cents = round(quote * 100). Rounding: Math.round (half up; every stored value is >= 0).
 *  - Overflow guard: any integer above 2^53-1 (or non-finite) rejects THAT record with reason 'overflow' (collector records it as a miss); nothing is silently clamped.
 *  - Adaptive scale (found on live data: FLOKI base bins hold 1.5e10 coins, 1.5e18 units at 8 decimals): per batch and pair the USED pd/bd are the declared ones reduced just enough that the largest value fits 2^53-1;
 *    the header stores both (declared + used), so reconstruction error is stated per pair (<= 0.5 x 10^-used per value). Only if even 0 decimals overflows is the record rejected.
 *  - Reconstruction tolerance (tested): prices exact when tick-aligned (else <= tick/2); base per bin <= (levels in bin) x lot/2, exact when the venue volumes are lot-aligned; every quote value <= 0.5 cent per value;
 *    wall shares are recomputed from the stored cents (<= 1e-4 absolute for a side denominator >= $1,000); wall TIER (q3/q5/q8) membership is stored explicitly, so it never flips on rounding.
 *  - Retained fields: id parts, times (ms), levels, cap flags, farthest, mid/spread, depth quote+coverage at 1/2/5/10 %, bins (base,quote), wall eligible/total mass + tier, denominators, reliability, intervals (sums, no per-level terms).
 *    NOT retained: depth base/levels per pct, per-level terms, Coinbase sub-millisecond exchange time, numOrders, any raw level.
 * Batch = { c: codecVersion, s: schemaVersion, t0: ISO of earliest request, pairs: [[pair, venue, pdUsed, bdUsed, quote, pdDeclared, bdDeclared]], grids: [gridId], meta, r: [compact records...] } */
(function (root, factory) { if (typeof module !== 'undefined' && module.exports) module.exports = factory(); else root.BookCodec = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var CODEC_VERSION = 1, SCHEMA = 2, MAXI = 9007199254740991, PCTS = [1, 2, 5, 10];
  function CodecError(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function decimalsOf(x) { var s = String(x), m = /^([0-9.]+)e-(\d+)$/i.exec(s); if (m) { var d = (m[1].split('.')[1] || '').length; return d + (+m[2]); } var i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
  function scaleFor(tick, lot, quote) { return { pd: decimalsOf(tick), bd: decimalsOf(lot), quote: quote || null }; }
  function toInt(x, dec) { if (x == null) return null; var v = Math.round(x * Math.pow(10, dec)); if (!isFinite(v) || v > MAXI || v < 0) throw CodecError('overflow', 'value ' + x + ' x 10^' + dec + ' outside the safe integer range'); return v; }
  function cents(x) { return toInt(x, 2); }
  function fromInt(v, dec) { return v == null ? null : Number((v / Math.pow(10, dec)).toFixed(dec)); }
  var F = { capB: 1, capA: 2, auction: 4, empty: 8, relB: 16, relA: 32, excl: 64 };
  function encodeRecord(rec, ref) {   // ref: { pairIdx, gridIdx, scale, t0Ms }
    var sc = ref.scale, fl = 0;
    if (rec.capReached.b) fl |= F.capB; if (rec.capReached.a) fl |= F.capA; if (rec.auction) fl |= F.auction; if (rec.empty) fl |= F.empty; if (rec.excludedFromContinuous) fl |= F.excl;
    if (rec.walls && rec.walls.reliable.b) fl |= F.relB; if (rec.walls && rec.walls.reliable.a) fl |= F.relA;
    var reqMs = Date.parse(rec.req), recvMs = Date.parse(rec.recv), out = [ref.pairIdx, ref.gridIdx, fl, reqMs - ref.t0Ms, recvMs - reqMs, rec.seq == null ? null : rec.seq, rec.xt ? Date.parse(rec.xt) - ref.t0Ms : null, rec.levels.b, rec.levels.a,
      rec.farthest.b == null ? null : toInt(rec.farthest.b, sc.pd), rec.farthest.a == null ? null : toInt(rec.farthest.a, sc.pd)];
    if (rec.empty || rec.mid == null) return out;
    out.push(toInt(rec.bestBid, sc.pd) + toInt(rec.bestAsk, sc.pd), toInt(rec.spread, sc.pd));
    if (rec.excludedFromContinuous || !rec.depth) return out;
    var mask = 0, d = [];
    rec.depth.forEach(function (x, i) { if (x.bid.coverage === 'lowerBound') mask |= 1 << (2 * i); if (x.ask.coverage === 'lowerBound') mask |= 1 << (2 * i + 1); d.push(cents(x.bid.quote), cents(x.ask.quote)); });
    out.push(mask); Array.prototype.push.apply(out, d);
    out.push(cents(rec.walls.denominator.b), cents(rec.walls.denominator.a));
    ['b', 'a'].forEach(function (s) { var flat = [], prev = 0; rec.bins[s].forEach(function (x) { flat.push(x[0] - prev, toInt(x[1], sc.bd), cents(x[2])); prev = x[0]; }); out.push(flat); });
    var tier = {}; ['q3', 'q5', 'q8'].forEach(function (k, ti) { (rec.walls[k] || []).forEach(function (w) { var key = (w[0] === 'b' ? 0 : 1) * 1000 + w[1]; tier[key] = { t: [3, 5, 8][ti], elig: w[3], tot: w[4] }; }); });
    var wl = []; Object.keys(tier).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) { wl.push(k * 10 + tier[k].t, cents(tier[k].elig), cents(tier[k].tot)); }); out.push(wl);
    var iv = []; (rec.intervals || []).forEach(function (x) { iv.push(x.name, x.side === 'b' ? 0 : 1, toInt(x.lo, sc.pd), toInt(x.hi, sc.pd), cents(x.quote), toInt(x.base, sc.bd), x.levels, x.coverage === 'complete' ? 0 : 1); }); out.push(iv);
    return out;
  }
  function decodeRecord(a, h, idx) {   // h = decoded header context
    var P = h.pairs[a[0]], sc = { pd: P[2], bd: P[3] }, fl = a[2], t0 = h.t0Ms, reqMs = t0 + a[3], recvMs = reqMs + a[4];
    var rec = { id: P[1] + '|' + P[0] + '|' + new Date(reqMs).toISOString(), v: SCHEMA, venue: P[1], pair: P[0], quote: P[4], req: new Date(reqMs).toISOString(), recv: new Date(recvMs).toISOString(), xt: a[6] == null ? null : new Date(t0 + a[6]).toISOString(), seq: a[5], auction: !!(fl & F.auction),
      grid: h.grids[a[1]], levels: { b: a[7], a: a[8] }, capReached: { b: !!(fl & F.capB), a: !!(fl & F.capA) }, farthest: { b: fromInt(a[9], sc.pd), a: fromInt(a[10], sc.pd) } };
    if (fl & F.empty) { rec.empty = true; return rec; }
    var m2 = a[11], sp = a[12]; rec.bestBid = fromInt((m2 - sp) / 2, sc.pd); rec.bestAsk = fromInt((m2 + sp) / 2, sc.pd); rec.mid = Number(((rec.bestBid + rec.bestAsk) / 2).toPrecision(10)); rec.spread = fromInt(sp, sc.pd);
    rec.spreadPct = Number((rec.spread / rec.mid * 100).toPrecision(10));
    rec.farthestPct = { b: rec.farthest.b == null ? null : Number(((rec.mid - rec.farthest.b) / rec.mid * 100).toPrecision(10)), a: rec.farthest.a == null ? null : Number(((rec.farthest.a - rec.mid) / rec.mid * 100).toPrecision(10)) };
    if (fl & F.excl) { rec.excludedFromContinuous = true; return rec; }
    var mask = a[13]; rec.depth = PCTS.map(function (p, i) { return { pct: p, bid: { quote: fromInt(a[14 + 2 * i], 2), coverage: (mask >> (2 * i)) & 1 ? 'lowerBound' : 'complete' }, ask: { quote: fromInt(a[15 + 2 * i], 2), coverage: (mask >> (2 * i + 1)) & 1 ? 'lowerBound' : 'complete' } }; });
    var den = { b: fromInt(a[22], 2), a: fromInt(a[23], 2) }; rec.bins = { b: [], a: [] };
    [24, 25].forEach(function (k, si) { var s = si ? 'a' : 'b', prev = 0, f = a[k]; for (var i = 0; i < f.length; i += 3) { prev += f[i]; rec.bins[s].push([prev, fromInt(f[i + 1], sc.bd), fromInt(f[i + 2], 2)]); } });
    var w = { regionPct: 10, denominator: den, coverage: { b: (mask >> 6) & 1 ? 'lowerBound' : 'complete', a: (mask >> 7) & 1 ? 'lowerBound' : 'complete' }, reliable: { b: !!(fl & F.relB), a: !!(fl & F.relA) }, q3: [], q5: [], q8: [] };
    for (var j = 0; j < a[26].length; j += 3) { var code = a[26][j], t = code % 10, key = (code - t) / 10, s2 = key >= 1000 ? 'a' : 'b', i2 = key % 1000, d = den[s2], e = [s2, i2, d > 0 ? Number((fromInt(a[26][j + 1], 2) / d).toPrecision(10)) : null, fromInt(a[26][j + 1], 2), fromInt(a[26][j + 2], 2)];
      w.q3.push(e); if (t >= 5) w.q5.push(e); if (t >= 8) w.q8.push(e); }
    rec.walls = w; rec.intervals = [];
    for (var q = 0; q < a[27].length; q += 8) rec.intervals.push({ name: a[27][q], side: a[27][q + 1] ? 'a' : 'b', lo: fromInt(a[27][q + 2], sc.pd), hi: fromInt(a[27][q + 3], sc.pd), quote: fromInt(a[27][q + 4], 2), base: fromInt(a[27][q + 5], sc.bd), levels: a[27][q + 6], coverage: a[27][q + 7] ? 'lowerBound' : 'complete' });
    return rec;
  }
  // scales: { 'venue|pair': { pd, bd, quote } }. Records that cannot be encoded are returned in `rejected` (never clamped).
  function encodeBatch(records, scales, meta) {
    var pairs = [], pIdx = {}, grids = [], gIdx = {}, rej = [], t0Ms = Infinity;
    records.forEach(function (r) { var t = Date.parse(r.req); if (t < t0Ms) t0Ms = t; });
    var out = [], stats = {};
    records.forEach(function (r) {   // largest price-like / base-like magnitude per pair (for the adaptive used scale)
      var k = r.venue + '|' + r.pair, s = stats[k] || (stats[k] = { p: 0, b: 0 }); function P(x) { if (x != null && x > s.p) s.p = x; } function Bq(x) { if (x != null && x > s.b) s.b = x; }
      if (r.farthest) { P(r.farthest.b); P(r.farthest.a); } P(r.bestBid); P(r.bestAsk ? r.bestAsk * 2 : null); (r.intervals || []).forEach(function (x) { P(x.lo); P(x.hi); Bq(x.base); });
      if (r.bins) ['b', 'a'].forEach(function (sd) { (r.bins[sd] || []).forEach(function (x) { Bq(x[1]); }); });
    });
    function fit(dec, mx) { while (dec > 0 && mx * Math.pow(10, dec) > MAXI) dec--; return dec; }
    var used = {};
    records.forEach(function (r) {
      try {
        var key = r.venue + '|' + r.pair, decl = scales[key]; if (!decl) throw CodecError('no-scale', 'no declared scale for ' + key);
        var sc = used[key] || (used[key] = { pd: fit(decl.pd, stats[key].p), bd: fit(decl.bd, stats[key].b), quote: decl.quote });
        if (pIdx[key] == null) { pIdx[key] = pairs.length; pairs.push([r.pair, r.venue, sc.pd, sc.bd, r.quote || decl.quote || null, decl.pd, decl.bd]); }
        if (gIdx[r.grid] == null) { gIdx[r.grid] = grids.length; grids.push(r.grid); }
        out.push(encodeRecord(r, { pairIdx: pIdx[key], gridIdx: gIdx[r.grid], scale: sc, t0Ms: t0Ms }));
      } catch (e) { rej.push({ id: r.id, reason: e.code || 'error', msg: String(e.message).slice(0, 100) }); }
    });
    return { batch: { c: CODEC_VERSION, s: SCHEMA, t0: isFinite(t0Ms) ? new Date(t0Ms).toISOString() : null, pairs: pairs, grids: grids, meta: meta || null, r: out }, rejected: rej };
  }
  function decodeBatch(batch) {
    if (!batch || batch.c !== CODEC_VERSION) throw CodecError('codec-version', 'unsupported codec ' + (batch && batch.c));
    var h = { pairs: batch.pairs, grids: batch.grids, t0Ms: batch.t0 ? Date.parse(batch.t0) : 0 };
    return batch.r.map(function (a, i) { return decodeRecord(a, h, i); });
  }
  function serializeBatch(batch) { return JSON.stringify(batch); }
  // ---- tolerance comparison (tests + collector self-check) ----
  function compare(orig, dec, sc) {
    var worst = { price: 0, base: 0, quote: 0, share: 0 }, bad = [];
    function pr(a, b, what) { if (a == null && b == null) return; if (a == null || b == null) { bad.push(what + ' null mismatch'); return; } worst.price = Math.max(worst.price, Math.abs(a - b)); }
    ['id', 'venue', 'pair', 'quote', 'req', 'recv', 'seq', 'auction', 'grid'].forEach(function (k) { if (orig[k] !== dec[k]) bad.push(k + ' ' + orig[k] + ' vs ' + dec[k]); });
    if (JSON.stringify(orig.levels) !== JSON.stringify(dec.levels)) bad.push('levels'); if (JSON.stringify(orig.capReached) !== JSON.stringify(dec.capReached)) bad.push('capReached');
    if (orig.xt && Math.abs(Date.parse(orig.xt) - Date.parse(dec.xt)) > 1) bad.push('xt'); if (!orig.xt && dec.xt) bad.push('xt');
    pr(orig.farthest.b, dec.farthest.b, 'farB'); pr(orig.farthest.a, dec.farthest.a, 'farA');
    if (orig.empty) { if (!dec.empty) bad.push('empty'); return { worst: worst, bad: bad }; }
    pr(orig.mid, dec.mid, 'mid'); pr(orig.bestBid, dec.bestBid, 'bb'); pr(orig.bestAsk, dec.bestAsk, 'ba'); pr(orig.spread, dec.spread, 'spread');
    if (orig.excludedFromContinuous) { if (!dec.excludedFromContinuous) bad.push('excl'); return { worst: worst, bad: bad }; }
    orig.depth.forEach(function (x, i) { ['bid', 'ask'].forEach(function (s) { worst.quote = Math.max(worst.quote, Math.abs(x[s].quote - dec.depth[i][s].quote)); if (x[s].coverage !== dec.depth[i][s].coverage) bad.push('cov ' + x.pct + s); }); });
    ['b', 'a'].forEach(function (s) {
      if (orig.bins[s].length !== dec.bins[s].length) { bad.push('bins ' + s + ' length'); return; }
      orig.bins[s].forEach(function (x, i) { var y = dec.bins[s][i]; if (x[0] !== y[0]) bad.push('bin idx'); worst.base = Math.max(worst.base, Math.abs(x[1] - y[1])); worst.quote = Math.max(worst.quote, Math.abs(x[2] - y[2])); });
      if (orig.walls.reliable[s] !== dec.walls.reliable[s]) bad.push('reliable ' + s); if (orig.walls.coverage[s] !== dec.walls.coverage[s]) bad.push('wallcov ' + s); worst.quote = Math.max(worst.quote, Math.abs(orig.walls.denominator[s] - dec.walls.denominator[s]));
    });
    ['q3', 'q5', 'q8'].forEach(function (k) {
      var A = orig.walls[k].map(function (w) { return w[0] + w[1]; }).sort().join(','), Bd = dec.walls[k].map(function (w) { return w[0] + w[1]; }).sort().join(','); if (A !== Bd) bad.push('wall tier set ' + k);
      if (k === 'q3') orig.walls.q3.forEach(function (w) { var y = dec.walls.q3.filter(function (z) { return z[0] === w[0] && z[1] === w[1]; })[0]; if (y) { worst.share = Math.max(worst.share, Math.abs(w[2] - y[2])); worst.quote = Math.max(worst.quote, Math.abs(w[3] - y[3]), Math.abs(w[4] - y[4])); } });
    });
    (orig.intervals || []).forEach(function (x, i) { var y = dec.intervals[i]; if (!y || x.name !== y.name || x.coverage !== y.coverage || x.levels !== y.levels) bad.push('interval ' + i); else { worst.quote = Math.max(worst.quote, Math.abs(x.quote - y.quote)); worst.base = Math.max(worst.base, Math.abs(x.base - y.base)); } });
    return { worst: worst, bad: bad };
  }
  // bytes/day at the declared envelope: records/day = 3,912 + 72*H (163 venue-pair mappings hourly = 3,912; each mapping promoted to 15 min adds 72)
  function envelope(bytesPerRecord, H, windowDays) { var rec = 3912 + 72 * H; return { H: H, recordsPerDay: rec, MBperDay: rec * bytesPerRecord / 1e6, MBwindow: rec * bytesPerRecord * (windowDays || 28) / 1e6 }; }
  return { CODEC_VERSION: CODEC_VERSION, SCHEMA: SCHEMA, CodecError: CodecError, decimalsOf: decimalsOf, scaleFor: scaleFor, toInt: toInt, fromInt: fromInt, encodeRecord: encodeRecord, decodeRecord: decodeRecord, encodeBatch: encodeBatch, decodeBatch: decodeBatch, serializeBatch: serializeBatch, compare: compare, envelope: envelope };
});
