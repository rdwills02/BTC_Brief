/* radar_tools/book/book-core.js — item 52a: order-book depth, pure functions (no I/O). SPIKE MODULE: nothing here is published or wired into capture/provisional/generations.
 * Venues: Kraken Depth (<= 500 aggregated levels per side, per-level timestamps, NO exchange snapshot time) and Coinbase level 2 (full aggregated book; sizes already aggregated - never multiplied by order count;
 * sequence/time and auction status kept; auction books are flagged and excluded from continuous measures).
 * Conventions (declared, exploratory, no predictive validity claimed): fixed absolute-price grid per pair per comparison period (version 1); quote value = SUM(price x base size); depth at +-1/2/5/10 % of the
 * snapshot mid; walls only inside +-10 % of the snapshot mid, qualifying at >= 5 % of that side's +-10 % depth (3 % and 8 % flagged as sensitivity); coverage = complete | lowerBound from the farthest returned price.
 * 52b repairs: walls numerator/denominator share one raw-level predicate (A1); every comparison needs same venue+pair+grid (A2); distinct snapshots vs SCHEDULED opportunities with an effective-dated cadence table (A3);
 * qualification-state transitions replace "disappeared" (A4); reliable-t0 population + separate baseline-ineligible count (A5); no cross-venue function (A6); grid v2 id = venue|pair|anchor|version (A7).
 * Names: "sampled price-zone persistence", "sampled wall-disappearance" (outcomes: persisted | lost-qualification | outside-region | unknown-*). L2 snapshots cannot follow individual orders. */
(function (root, factory) { if (typeof module !== 'undefined' && module.exports) module.exports = factory(); else root.BookCore = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SCHEMA_VERSION = 2, GRID_VERSION = 2, DEPTH_PCTS = [1, 2, 5, 10], WALL_PCTS = [3, 5, 8], WALL_REGION_PCT = 10, WALL_MAIN = 5;
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function sig(x) { return num(x) ? Number(x.toPrecision(10)) : x; }   // stored numbers: 10 significant digits

  // ---------- parsing ----------
  // Kraken: result object for one pair { asks: [[price, volume, timestamp]], bids: [...] }; `count` = the request's count parameter (the level cap).
  function parseKraken(raw, ctx) {
    var cap = ctx.count || 500, lv = function (a) { return (a || []).map(function (x) { return { p: parseFloat(x[0]), q: parseFloat(x[1]), t: num(Number(x[2])) ? Number(x[2]) : null }; }).filter(function (x) { return num(x.p) && num(x.q) && x.q > 0; }); };
    var bids = lv(raw.bids).sort(function (a, b) { return b.p - a.p; }), asks = lv(raw.asks).sort(function (a, b) { return a.p - b.p; });
    return finish({ venue: 'kraken', pair: ctx.pair, bids: bids, asks: asks, exchangeTime: null, sequence: null, auction: false, cap: cap, reqStart: ctx.requestStartUtc, recv: ctx.receivedAtUtc, completeBook: false });
  }
  // Coinbase level 2: { bids: [[price, size, numOrders]], asks, sequence, auction_mode, auction, time }. Size is the aggregate at the price - numOrders is IGNORED.
  function parseCoinbase(raw, ctx) {
    var lv = function (a) { return (a || []).map(function (x) { return { p: parseFloat(x[0]), q: parseFloat(x[1]), t: null }; }).filter(function (x) { return num(x.p) && num(x.q) && x.q > 0; }); };
    var bids = lv(raw.bids).sort(function (a, b) { return b.p - a.p; }), asks = lv(raw.asks).sort(function (a, b) { return a.p - b.p; });
    var auction = raw.auction_mode === true || (raw.auction && raw.auction.auction_state && raw.auction.auction_state !== 'continuous' && raw.auction_mode !== false);
    return finish({ venue: 'coinbase', pair: ctx.pair, bids: bids, asks: asks, exchangeTime: raw.time || null, sequence: num(raw.sequence) ? raw.sequence : null, auction: !!auction, cap: null, reqStart: ctx.requestStartUtc, recv: ctx.receivedAtUtc, completeBook: true });
  }
  function finish(b) {
    var bb = b.bids.length ? b.bids[0].p : null, ba = b.asks.length ? b.asks[0].p : null, mid = (bb != null && ba != null) ? (bb + ba) / 2 : null;
    b.mid = mid; b.bestBid = bb; b.bestAsk = ba; b.spread = (bb != null && ba != null) ? ba - bb : null;
    b.levels = { b: b.bids.length, a: b.asks.length };
    b.farthest = { b: b.bids.length ? b.bids[b.bids.length - 1].p : null, a: b.asks.length ? b.asks[b.asks.length - 1].p : null };
    b.capReached = { b: !b.completeBook && b.cap != null && b.bids.length >= b.cap, a: !b.completeBook && b.cap != null && b.asks.length >= b.cap };
    return b;
  }

  // ---------- fixed absolute-price grid (version 1) ----------
  // Anchored at the pair's tick-rounded reference price (the first snapshot's mid of the comparison period); stored with the period; never moves with the mid.
  // Steps: 0.25 % within +-5 %, 0.5 % for 5-10 %, 1 % for 10-20 %, one tail bin beyond each side. Bin 0 = below the low tail edge; bins 1..80 = [edge[i-1], edge[i]); bin 81 = at/above the high tail edge.
  function roundToTick(x, tick) { return tick > 0 ? Math.round(x / tick) * tick : x; }
  function stepTableBp() { var bp = [], x; for (x = -2000; x < -1000; x += 100) bp.push(x); for (x = -1000; x < -500; x += 50) bp.push(x); for (x = -500; x < 0; x += 25) bp.push(x); for (x = 0; x < 500; x += 25) bp.push(x); for (x = 500; x < 1000; x += 50) bp.push(x); for (x = 1000; x <= 2000; x += 100) bp.push(x); return bp; }
  function makeGrid(refPrice, tick, period, venue, pair) {
    var anchor = sig(roundToTick(refPrice, tick || 0)), bp = stepTableBp();
    return { version: GRID_VERSION, venue: venue || '', pair: pair || '', period: period || null, anchor: anchor, tick: tick || null, stepsBp: { inner: 25, innerTo: 500, mid: 50, midTo: 1000, outer: 100, outerTo: 2000 }, edgesBp: bp, bins: bp.length + 1,
      edges: bp.map(function (b) { return anchor * (1 + b / 10000); }) };
  }
  function binIndex(grid, price) {   // [edge[i-1], edge[i]) ; below the first edge -> 0 ; at/above the last edge -> edges.length
    var e = grid.edges, lo = 0, hi = e.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (price >= e[m]) lo = m + 1; else hi = m; }
    return lo;
  }
  function binBounds(grid, i) { var e = grid.edges; return { lo: i === 0 ? null : e[i - 1], hi: i >= e.length ? null : e[i] }; }
  function gridId(grid) { return (grid.venue || '') + '|' + (grid.pair || '') + '|' + grid.anchor + '|v' + GRID_VERSION; }   // grid id = venue|pair|anchor|version (period is stored beside it, not in it)
  function gridFromId(id) { var a = String(id || '').split('|'); if (a.length !== 4 || !/^v\d+$/.test(a[3]) || !(+a[2] > 0)) return null; return { venue: a[0], pair: a[1], anchor: +a[2], version: +a[3].slice(1) }; }
  function gridChange(prev, next, reason, atUtc) { return { at: atUtc || null, reason: reason || null, from: prev ? gridId(prev) : null, to: gridId(next), period: next.period || null }; }
  // quote value of each bin = SUM(price x size) over the raw levels in it (never size x bin midpoint)
  function aggregate(book, grid) {
    var out = { b: {}, a: {} };
    ['b', 'a'].forEach(function (s) { (s === 'b' ? book.bids : book.asks).forEach(function (l) { var i = binIndex(grid, l.p), x = out[s][i] || (out[s][i] = { base: 0, quote: 0 }); x.base += l.q; x.quote += l.p * l.q; }); });
    return out;
  }

  // ---------- coverage ----------
  // A side's returned levels cover a boundary price when the book was returned in full (not cap-limited), or the farthest returned level reaches/passes the boundary.
  function sideCoverage(book, side, boundaryPrice) {
    var capped = book.capReached[side], far = book.farthest[side];
    if (!capped) return 'complete';
    if (far == null) return 'lowerBound';
    return side === 'b' ? (far <= boundaryPrice ? 'complete' : 'lowerBound') : (far >= boundaryPrice ? 'complete' : 'lowerBound');
  }
  function cumQuote(levels, pred) { var q = 0, b = 0, n = 0; levels.forEach(function (l) { if (pred(l.p)) { q += l.p * l.q; b += l.q; n++; } }); return { quote: q, base: b, n: n }; }
  function depthAt(book, pct) {
    var lo = book.mid * (1 - pct / 100), hi = book.mid * (1 + pct / 100), b = cumQuote(book.bids, function (p) { return p >= lo; }), a = cumQuote(book.asks, function (p) { return p <= hi; });
    return { pct: pct, bid: { quote: sig(b.quote), base: sig(b.base), levels: b.n, coverage: sideCoverage(book, 'b', lo) }, ask: { quote: sig(a.quote), base: sig(a.base), levels: a.n, coverage: sideCoverage(book, 'a', hi) } };
  }
  // Exact interval sum from RAW levels. Convention: closed interval [lo, hi] on price. Bid side L->S: lo = S, hi = L. Ask side L->T: lo = L, hi = T. Order terms (price, size) are kept up to maxTerms.
  function intervalSum(book, side, lo, hi, name, maxTerms) {
    var lv = side === 'b' ? book.bids : book.asks, terms = [], q = 0, b = 0, n = 0;
    lv.forEach(function (l) { if (l.p >= lo && l.p <= hi) { q += l.p * l.q; b += l.q; n++; if (terms.length < (maxTerms == null ? 40 : maxTerms)) terms.push([l.p, l.q]); } });
    var cov = sideCoverage(book, side, side === 'b' ? lo : hi);
    return { name: name || null, side: side, lo: lo, hi: hi, convention: 'closed [lo,hi] on price; quote = sum(price x size); bid L->S: lo=S hi=L; ask L->T: lo=L hi=T', quote: sig(q), base: sig(b), levels: n, coverage: cov, termsTruncated: n > terms.length, terms: terms };
  }

  // ---------- walls (inside +-10 % of the snapshot mid only) ----------
  // A1: numerator (eligible mass of a bin) and denominator (side +-10 % depth) are built from the SAME raw-level predicate - a level counts iff its price is inside the region.
  // A bin straddling the boundary therefore contributes only its in-region levels; share = eligible / denominator can never exceed 1. Entries: [side, bin, share, eligibleQuote, binTotalQuote].
  function walls(book, grid, agg) {
    var lo = book.mid * (1 - WALL_REGION_PCT / 100), hi = book.mid * (1 + WALL_REGION_PCT / 100), res = { regionPct: WALL_REGION_PCT, region: [sig(lo), sig(hi)], denominator: {}, coverage: {}, reliable: {}, q3: [], q5: [], q8: [] };
    ['b', 'a'].forEach(function (s) {
      var elig = {}, den = 0, cov = sideCoverage(book, s, s === 'b' ? lo : hi);
      (s === 'b' ? book.bids : book.asks).forEach(function (l) { if (l.p >= lo && l.p <= hi) { var i = binIndex(grid, l.p), v = l.p * l.q; elig[i] = (elig[i] || 0) + v; den += v; } });
      res.denominator[s] = sig(den); res.coverage[s] = cov; res.reliable[s] = cov === 'complete' && den > 0;
      Object.keys(elig).forEach(function (k) {
        var i = +k, bd = binBounds(grid, i); if (bd.lo == null || bd.hi == null || !(den > 0)) return;   // tail bins are never walls
        var share = elig[k] / den, tot = agg[s][k] ? agg[s][k].quote : elig[k];
        WALL_PCTS.forEach(function (p) { if (share >= p / 100) res['q' + p].push([s, i, sig(share), sig(elig[k]), sig(tot)]); });
      });
    });
    return res;
  }

  // ---------- snapshot record ----------
  function quoteOf(pair) { var p = String(pair || '').split('/'); return p.length === 2 ? p[1] : null; }   // A6: quote currency recorded per pair, never pooled
  function snapshotId(venue, pair, requestStartUtc) { return venue + '|' + pair + '|' + requestStartUtc; }
  function buildRecord(book, grid, opts) {
    opts = opts || {};
    var rec = { id: snapshotId(book.venue, book.pair, book.reqStart), v: SCHEMA_VERSION, venue: book.venue, pair: book.pair, quote: quoteOf(book.pair), req: book.reqStart, recv: book.recv, xt: book.exchangeTime || null, seq: book.sequence, auction: !!book.auction };
    rec.grid = gridId(grid); rec.levels = book.levels; rec.capReached = book.capReached; rec.farthest = book.farthest;
    if (book.mid == null) { rec.empty = true; return rec; }
    rec.mid = sig(book.mid); rec.bestBid = sig(book.bestBid); rec.bestAsk = sig(book.bestAsk); rec.spread = sig(book.spread); rec.spreadPct = sig(book.spread / book.mid * 100);
    rec.farthestPct = { b: book.farthest.b == null ? null : sig((book.mid - book.farthest.b) / book.mid * 100), a: book.farthest.a == null ? null : sig((book.farthest.a - book.mid) / book.mid * 100) };
    if (book.auction) { rec.excludedFromContinuous = true; return rec; }   // indicative auction book: kept as a record, excluded from continuous measures
    var agg = aggregate(book, grid);
    rec.depth = DEPTH_PCTS.map(function (p) { return depthAt(book, p); });
    rec.bins = { b: Object.keys(agg.b).map(function (k) { return [+k, sig(agg.b[k].base), sig(agg.b[k].quote)]; }).sort(function (x, y) { return x[0] - y[0]; }), a: Object.keys(agg.a).map(function (k) { return [+k, sig(agg.a[k].base), sig(agg.a[k].quote)]; }).sort(function (x, y) { return x[0] - y[0]; }) };
    rec.walls = walls(book, grid, agg);
    rec.intervals = (opts.intervals || []).map(function (iv) { return intervalSum(book, iv.side, iv.lo, iv.hi, iv.name, opts.maxTerms); });
    return rec;
  }

  // ---------- serialisation ----------
  function serialize(rec) { return JSON.stringify(rec); }
  function deserialize(s) { return JSON.parse(s); }
  function batchPath(venue, requestStartUtc) { var d = requestStartUtc.slice(0, 10), hm = requestStartUtc.slice(11, 13) + requestStartUtc.slice(14, 16); return 'data/book/' + venue + '/' + d + '/' + hm + '.json'; }
  function batchFile(records, meta) { return JSON.stringify({ schema: SCHEMA_VERSION, meta: meta || null, records: records }); }
  function dedupeById(records) { var seen = {}, out = []; records.forEach(function (r) { if (!seen[r.id]) { seen[r.id] = 1; out.push(r); } }); return out; }
  function gzipSize(str, gzipFn) { if (gzipFn) return gzipFn(str); if (typeof require === 'function') { try { return require('zlib').gzipSync(Buffer.from(str, 'utf8'), { level: 9 }).length; } catch (e) { return null; } } return null; }
  function byteLen(str) { return typeof Buffer !== 'undefined' ? Buffer.byteLength(str, 'utf8') : new TextEncoder().encode(str).length; }

  // ---------- rollups ----------
  function qualifies(rec, side, idx, key) { var w = rec.walls && rec.walls[key || 'q5']; if (!w) return false; for (var i = 0; i < w.length; i++) if (w[i][0] === side && w[i][1] === idx) return true; return false; }
  function binQuote(rec, side, idx) { var arr = rec.bins && rec.bins[side]; if (!arr) return 0; for (var i = 0; i < arr.length; i++) if (arr[i][0] === idx) return arr[i][2]; return 0; }
  function sideReliable(rec, side) { return !!(rec.walls && rec.walls.reliable && rec.walls.reliable[side]); }
  // A6: no function combines venues.
  function assertSingleVenue(records) { var v = null; records.forEach(function (r) { if (v == null) v = r.venue; else if (r.venue !== v) throw new Error('mixed venues (' + v + ', ' + r.venue + '): venue measures are never combined'); }); return v; }
  function content(r) { var c = {}; Object.keys(r).forEach(function (k) { if (k !== 'recvMs' && k !== 'reqMs') c[k] = r[k]; }); return JSON.stringify(c); }
  // A3: distinct snapshot ids only; a repeated id with different content is a CONFLICT - every copy of it is rejected and recorded.
  function dedupeSnapshots(records) {
    var by = {}, order = [], conflicts = [], dropped = 0;
    records.forEach(function (r) { var h = content(r), e = by[r.id]; if (!e) { by[r.id] = { rec: r, hash: h, bad: false }; order.push(r.id); } else if (e.hash !== h) { if (!e.bad) conflicts.push(r.id); e.bad = true; } else dropped++; });
    return { records: order.filter(function (id) { return !by[id].bad; }).map(function (id) { return by[id].rec; }), conflicts: conflicts, duplicatesDropped: dropped };
  }
  // Effective-dated cadence table: [{ venue, pair, tier, cadenceMs, fromMs, toMs|null }]. Scheduled opportunities = per segment floor(overlap / cadence), summed.
  function scheduledCount(table, venue, pair, fromMs, toMs) {
    var n = 0, any = false;
    (table || []).forEach(function (e) { if (e.venue !== venue || e.pair !== pair) return; any = true; var a = Math.max(fromMs, e.fromMs), z = Math.min(toMs, e.toMs == null ? toMs : e.toMs); if (z > a) n += Math.floor((z - a) / e.cadenceMs); });
    return any ? n : null;
  }
  // Trailing clock-time window ending at cutoffMs. o: { cutoffMs, windowMs, cadenceMs | cadenceTable, minCoverage (0..1), maxAgeMs, wallKey }. Records are continuous (non-auction) snapshots with recvMs.
  function windowStats(records, o) {
    var from = o.cutoffMs - o.windowMs, cont = records.filter(function (r) { return !r.auction && !r.empty; }); assertSingleVenue(cont);
    var dd = dedupeSnapshots(cont), obs = dd.records.filter(function (r) { return r.recvMs > from && r.recvMs <= o.cutoffMs; }).sort(function (a, b) { return a.recvMs - b.recvMs; });
    var venue = obs.length ? obs[0].venue : null, pair = obs.length ? obs[0].pair : null, expected = o.cadenceTable ? scheduledCount(o.cadenceTable, venue, pair, from, o.cutoffMs) : Math.floor(o.windowMs / o.cadenceMs);
    var maxAge = obs.length ? o.cutoffMs - obs[obs.length - 1].recvMs : null, gaps = [], prev = from, cad = o.cadenceMs || (o.cadenceTable && obs.length ? (o.cadenceTable.filter(function (e) { return e.venue === venue && e.pair === pair; })[0] || {}).cadenceMs : null);
    if (cad) { obs.forEach(function (r) { if (r.recvMs - prev > 1.5 * cad) gaps.push({ fromMs: prev, toMs: r.recvMs }); prev = r.recvMs; }); if (o.cutoffMs - prev > 1.5 * cad) gaps.push({ fromMs: prev, toMs: o.cutoffMs }); }
    var out = { windowMs: o.windowMs, cadenceMs: cad || null, venue: venue, pair: pair, expected: expected, observed: obs.length, duplicatesDropped: dd.duplicatesDropped, conflicts: dd.conflicts, maxAgeMs: maxAge, gaps: gaps, minCoverage: o.minCoverage, maxAgeLimitMs: o.maxAgeMs, status: 'ok', reason: null, bins: {} };
    if (!obs.length) { out.status = 'unknown'; out.reason = 'no observations'; return out; }
    var pairs = {}, grids = {}; obs.forEach(function (r) { pairs[r.pair] = 1; grids[r.grid] = 1; });
    if (Object.keys(pairs).length > 1) { out.status = 'unknown'; out.reason = 'pair-mismatch'; return out; }
    if (Object.keys(grids).length > 1) { out.status = 'unknown'; out.reason = 'grid-mismatch'; return out; }
    if (!(expected > 0)) { out.status = 'unknown'; out.reason = 'no scheduled opportunities for this pair in the window'; return out; }
    if (o.maxAgeMs != null && maxAge > o.maxAgeMs) { out.status = 'unknown'; out.reason = 'newest observation older than the age limit'; }
    var seen = {}; obs.forEach(function (r) { ['b', 'a'].forEach(function (s) { (r.bins[s] || []).forEach(function (x) { seen[s + x[0]] = [s, x[0]]; }); }); });
    Object.keys(seen).forEach(function (k) {
      var s = seen[k][0], idx = seen[k][1], cov = obs.filter(function (r) { return sideReliable(r, s); }), q = 0, qual = 0;
      cov.forEach(function (r) { q += binQuote(r, s, idx); if (qualifies(r, s, idx, o.wallKey)) qual++; });
      var ratio = expected > 0 ? cov.length / expected : 0, ok = out.status === 'ok' && ratio >= o.minCoverage;
      out.bins[k] = { side: s, idx: idx, observedCovered: cov.length, qualifying: qual, meanQuote: cov.length ? sig(q / cov.length) : null, persistence: ok && cov.length ? sig(qual / cov.length) : null, status: ok ? 'ok' : 'unknown' };
    });
    if (out.status === 'ok' && obs.length / Math.max(1, expected) < o.minCoverage) { out.status = 'unknown'; out.reason = 'observed/expected below the minimum coverage'; }
    return out;
  }
  // A qualification-state transition for a bin that qualified at t0 (reliable side) vs the FIRST observed snapshot of the SAME venue+pair at/after t0 + h (within toleranceMs).
  // outcome: persisted | lost-qualification | outside-region | unknown-missing | unknown-grid | unknown-unreliable-t0 ; status is the coarse label (persisted | lost-qualification | outside-region | unknown). "disappeared" is gone.
  function wallTransition(records, o) {
    var pool = records.filter(function (r) { return !r.auction && !r.empty && (!o.venue || r.venue === o.venue) && (!o.pair || r.pair === o.pair); });
    var t0 = pool.filter(function (r) { return r.recvMs === o.t0Ms; })[0];
    function unk(outcome, reason, extra) { var x = { horizonMs: o.horizonMs, status: 'unknown', outcome: outcome, reason: reason }; if (extra) Object.keys(extra).forEach(function (k) { x[k] = extra[k]; }); return x; }
    if (!t0 || !qualifies(t0, o.side, o.idx, o.wallKey) || !sideReliable(t0, o.side)) return unk('unknown-unreliable-t0', 'bin does not qualify (or is not reliably covered) at t0');
    var target = o.t0Ms + o.horizonMs, same = pool.filter(function (r) { return r.venue === t0.venue && r.pair === t0.pair; });
    var nxt = same.filter(function (r) { return r.recvMs >= target; }).sort(function (a, b) { return a.recvMs - b.recvMs; })[0];
    if (!nxt || nxt.recvMs - target > (o.toleranceMs == null ? 0 : o.toleranceMs)) return unk('unknown-missing', 'no observed snapshot at the horizon');
    if (nxt.grid !== t0.grid) return unk('unknown-grid', 'grid-mismatch', { observedAtMs: nxt.recvMs });
    if (!sideReliable(nxt, o.side)) return unk('unknown-missing', 'horizon snapshot coverage incomplete', { observedAtMs: nxt.recvMs });
    var done = function (status, why) { return { horizonMs: o.horizonMs, status: status, outcome: status, reason: why || null, observedAtMs: nxt.recvMs }; };
    if (qualifies(nxt, o.side, o.idx, o.wallKey)) return done('persisted');
    var g = gridFromId(t0.grid), grid = g && makeGrid(g.anchor, null, null, g.venue, g.pair), bd = grid && binBounds(grid, o.idx);
    if (bd && bd.lo != null && nxt.mid != null) { var rl = nxt.mid * (1 - WALL_REGION_PCT / 100), rh = nxt.mid * (1 + WALL_REGION_PCT / 100); if (bd.hi <= rl || bd.lo > rh) return done('outside-region', 'zone left the +-10 % region of the later snapshot mid (mass is not claimed gone)'); }
    return done('lost-qualification', 'zone inside the region no longer reaches the qualifying share');
  }
  // Population: walls reliable at t0 only; walls on unreliable/lowerBound sides are counted separately as baselineIneligible. One venue per call.
  function transitions(records, o) {
    var cont = records.filter(function (r) { return !r.auction && !r.empty; }), venue = assertSingleVenue(cont), dd = dedupeSnapshots(cont), by = {};
    dd.records.forEach(function (r) { (by[r.pair] = by[r.pair] || []).push(r); });
    var out = { venue: venue, horizonMs: o.horizonMs, wallKey: o.wallKey || 'q5', n: 0, baselineIneligible: 0, counts: { 'persisted': 0, 'lost-qualification': 0, 'outside-region': 0, 'unknown-missing': 0, 'unknown-grid': 0, 'unknown-unreliable-t0': 0 }, conflicts: dd.conflicts };
    Object.keys(by).forEach(function (p) { var rs = by[p].sort(function (a, b) { return a.recvMs - b.recvMs; }); rs.forEach(function (r0) {
      (r0.walls && r0.walls[out.wallKey] || []).forEach(function (w) {
        if (!sideReliable(r0, w[0])) { out.baselineIneligible++; return; }
        var res = wallTransition(rs, { t0Ms: r0.recvMs, side: w[0], idx: w[1], horizonMs: o.horizonMs, toleranceMs: o.toleranceMs, wallKey: out.wallKey, venue: r0.venue, pair: r0.pair }); out.n++; out.counts[res.outcome]++; }); }); });
    return out;
  }

  // ---------- distribution helper ----------
  function dist(arr) {
    var x = arr.filter(num).sort(function (a, b) { return a - b; }), n = x.length; if (!n) return { n: 0, min: null, median: null, p90: null, max: null };
    var q = function (p) { var k = (n - 1) * p, lo = Math.floor(k), hi = Math.min(lo + 1, n - 1); return x[lo] + (k - lo) * (x[hi] - x[lo]); };
    return { n: n, min: x[0], median: q(0.5), p90: q(0.9), max: x[n - 1] };
  }
  return { SCHEMA_VERSION: SCHEMA_VERSION, GRID_VERSION: GRID_VERSION, parseKraken: parseKraken, parseCoinbase: parseCoinbase, makeGrid: makeGrid, binIndex: binIndex, binBounds: binBounds, gridId: gridId, aggregate: aggregate,
    sideCoverage: sideCoverage, depthAt: depthAt, intervalSum: intervalSum, walls: walls, gridFromId: gridFromId, gridChange: gridChange, quoteOf: quoteOf, snapshotId: snapshotId, buildRecord: buildRecord, serialize: serialize, deserialize: deserialize, batchPath: batchPath, batchFile: batchFile,
    dedupeById: dedupeById, gzipSize: gzipSize, byteLen: byteLen, windowStats: windowStats, wallTransition: wallTransition, wallDisappearance: wallTransition, transitions: transitions, dedupeSnapshots: dedupeSnapshots, scheduledCount: scheduledCount, assertSingleVenue: assertSingleVenue, dist: dist, qualifies: qualifies };
});

