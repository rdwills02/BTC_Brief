/* radar_tools/book/book-collector.js — item 52b C: order-book depth collector. ADVISORY and best-effort: it only READS data/latest-daily.json, data/daily/*, data/forward/CURRENT (+ generation orders.json) and data/book/holdings.json,
 * and WRITES only under --out. It never touches data/forward, data/daily, generations, capture, provisional or orders-core; any failure exits 0 with a failure marker (it can never fail or delay a canonical capture).
 * Pairs: every universe coin on Kraken (count=500) and Coinbase (level 2), USD > USDC > USDT. Tier 15 min = pairs of coins with an active order, an ACT/NEAR verdict, or in the holdings list; everything else hourly.
 * Cadence table is effective-dated and cumulative (a tier change closes the old entry and opens a new one) and is written with the batch. A sweep finishes or aborts within the deadline (default 10 min); misses are recorded.
 * Node: node book-collector.js --root <repo> --state <rolling-state-dir> --out <dir> [--now ISO]. Browser/test use: create(deps) with injected fetch/now/sleep. */
(function (root, factory) { if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./book-core.js'), require('./book-codec.js')); else root.BookCollector = factory(root.BookCore, root.BookCodec); })(typeof self !== 'undefined' ? self : this, function (B, C) {
  'use strict';
  var ALIAS = { BTC: ['XBT'], DOGE: ['XDG'], LUNA: ['LUNA2'] }, QUOTE_PREF = ['USD', 'USDC', 'USDT'], Q15 = 900000, H1 = 3600000, DEADLINE_MS = 600000, INACTIVE = ['exited', 'cancelled', 'canceled', 'expired', 'rejected', 'closed', 'void'];
  function iso(ms) { return new Date(ms).toISOString(); }
  function symMatch(sym, base) { base = String(base).toUpperCase(); return base === sym || (ALIAS[sym] || []).indexOf(base) >= 0; }
  // ---- pair mapping from the live venue listings ----
  function mapPairs(symbols, krakenAssetPairs, coinbaseProducts) {
    var kr = {}, cb = {}, out = { kraken: [], coinbase: [], unmapped: [], collisions: [] };
    Object.keys(krakenAssetPairs || {}).forEach(function (k) { var p = krakenAssetPairs[k], ws = p.wsname; if (!ws || ws.indexOf('/') < 0 || (p.status && p.status !== 'online')) return; var q = ws.split('/'); if (QUOTE_PREF.indexOf(q[1]) < 0) return;
      var b = q[0].toUpperCase(); (kr[b] = kr[b] || {})[q[1]] = { req: p.altname, pair: ws, tick: parseFloat(p.tick_size) || null, lot: p.lot_decimals != null ? Math.pow(10, -p.lot_decimals) : null, quote: q[1] }; });
    (Array.isArray(coinbaseProducts) ? coinbaseProducts : []).forEach(function (p) { if (p.status !== 'online' || p.trading_disabled || QUOTE_PREF.indexOf(p.quote_currency) < 0) return;
      var b = String(p.base_currency).toUpperCase(); (cb[b] = cb[b] || {})[p.quote_currency] = { req: p.id, pair: p.base_currency + '/' + p.quote_currency, tick: parseFloat(p.quote_increment) || null, lot: parseFloat(p.base_increment) || null, quote: p.quote_currency }; });
    function pick(tbl, sym) { var keys = Object.keys(tbl).filter(function (b) { return symMatch(sym, b); }); if (keys.length !== 1) return keys.length > 1 ? 'collision' : null; for (var i = 0; i < QUOTE_PREF.length; i++) if (tbl[keys[0]][QUOTE_PREF[i]]) return tbl[keys[0]][QUOTE_PREF[i]]; return null; }
    symbols.forEach(function (sym) { var k = pick(kr, sym), c = pick(cb, sym), bad = k === 'collision' || c === 'collision';
      if (k && k !== 'collision') out.kraken.push(Object.assign({ sym: sym }, k)); if (c && c !== 'collision') out.coinbase.push(Object.assign({ sym: sym }, c));
      if (bad) out.collisions.push(sym); if ((!k && !c) || bad) out.unmapped.push(sym); });
    return out;
  }
  // ---- tier membership ----
  function activeOrder(o) { return o && INACTIVE.indexOf(String(o.status || o.state || '').toLowerCase()) < 0; }
  function membership(inputs) {   // inputs: { coins:[{cgId,symbol,verdict}], orders:[...], holdings:[SYM] } -> { SYM: [reasons] }
    var bySym = {}, byCg = {}, m = {}; (inputs.coins || []).forEach(function (c) { var s = String(c.symbol || '').toUpperCase(); bySym[s] = c; byCg[c.cgId] = s; });
    function add(sym, why) { if (sym && bySym[sym]) (m[sym] = m[sym] || []).push(why); }
    (inputs.orders || []).filter(activeOrder).forEach(function (o) { add(byCg[o.cgId], 'order'); });
    (inputs.coins || []).forEach(function (c) { var v = String(c.verdict || '').toUpperCase(); if (v === 'ACT' || v === 'NEAR') add(String(c.symbol).toUpperCase(), v); });
    (inputs.holdings || []).forEach(function (s) { add(String(s).toUpperCase(), 'holding'); });
    return m;
  }
  // ---- effective-dated cadence table ----
  function updateCadence(prev, mapping, members, nowMs) {
    var table = (prev || []).map(function (e) { return Object.assign({}, e); }), changes = [], want = {};
    ['kraken', 'coinbase'].forEach(function (v) { mapping[v].forEach(function (m) { var hot = !!members[m.sym]; want[v + '|' + m.pair] = { venue: v, pair: m.pair, tier: hot ? 'q15' : 'h1', cadenceMs: hot ? Q15 : H1, reasons: hot ? members[m.sym].slice().sort() : [] }; }); });
    var open = {}; table.forEach(function (e) { if (e.toMs == null) open[e.venue + '|' + e.pair] = e; });
    Object.keys(open).forEach(function (k) { var e = open[k], w = want[k]; if (!w) { e.toMs = nowMs; changes.push({ venue: e.venue, pair: e.pair, from: e.tier, to: null, atMs: nowMs }); } else if (w.tier !== e.tier) { e.toMs = nowMs; changes.push({ venue: e.venue, pair: e.pair, from: e.tier, to: w.tier, atMs: nowMs }); } else e.reasons = w.reasons; });
    Object.keys(want).forEach(function (k) { var o = open[k]; if (!o || o.toMs === nowMs) { var w = want[k]; table.push({ venue: w.venue, pair: w.pair, tier: w.tier, cadenceMs: w.cadenceMs, reasons: w.reasons, fromMs: nowMs, toMs: null }); if (!o) changes.push({ venue: w.venue, pair: w.pair, from: null, to: w.tier, atMs: nowMs }); } });
    return { table: table, changes: changes };
  }
  function cadenceVersion(table) { var s = JSON.stringify(table), h = 5381; for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return 'c' + h.toString(16) + '-' + table.length; }
  function dueNow(table, venue, pair, nowMs) { var e = table.filter(function (x) { return x.venue === venue && x.pair === pair && x.toMs == null; })[0]; if (!e) return false; return e.cadenceMs === Q15 ? true : Math.floor(nowMs / Q15) % 4 === 0; }
  // ---- grids: one fixed absolute grid per pair per UTC month; re-anchor on drift > 15 % (recorded) ----
  function ensureGrid(state, venue, m, mid, nowMs) {
    var key = venue + '|' + m.pair, period = iso(nowMs).slice(0, 7), cur = state[key], reason = null;
    if (!cur) reason = 'first'; else if (cur.period !== period) reason = 'period-start'; else if (Math.abs(mid / cur.anchor - 1) > 0.15) reason = 'drift>15%';
    if (!reason) return { grid: B.makeGrid(cur.anchor, cur.tick, cur.period, venue, m.pair), change: null };
    var g = B.makeGrid(mid, m.tick, period, venue, m.pair), prev = cur ? B.makeGrid(cur.anchor, cur.tick, cur.period, venue, m.pair) : null;
    state[key] = { anchor: g.anchor, tick: m.tick, period: period, createdAt: iso(nowMs) };
    return { grid: g, change: B.gridChange(prev, g, reason, iso(nowMs)) };
  }
  // ---- intervals for active orders on this pair ----
  function intervalsFor(orders, symByCg, sym) {
    var out = [], seen = {}; (orders || []).filter(activeOrder).forEach(function (o) { if (symByCg[o.cgId] !== sym || !(o.S > 0) || !(o.L > 0) || !(o.T > 0)) return;
      [['b', o.S, o.L, 'L->S'], ['a', o.L, o.T, 'L->T']].forEach(function (x) { var k = x[0] + x[1] + '|' + x[2]; if (seen[k]) return; seen[k] = 1; out.push({ side: x[0], lo: x[1], hi: x[2], name: x[3] + ':' + o.id }); }); });
    return out;
  }
  // ---- sweep ----
  function create(deps) {
    var env = { fetch: deps.fetch, now: deps.now || function () { return Date.now(); }, sleep: deps.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }, minGapMs: deps.minGapMs || 1000, retries: deps.retries == null ? 2 : deps.retries, timeoutMs: deps.timeoutMs || 15000 };
    async function getJson(url) {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = ac ? setTimeout(function () { ac.abort(); }, env.timeoutMs) : null;
      try { var r = await env.fetch(url, ac ? { signal: ac.signal } : undefined); if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return await r.json(); } finally { if (timer) clearTimeout(timer); }
    }
    async function requestOne(venue, m, tStartRun, deadlineMs) {
      var url = venue === 'kraken' ? 'https://api.kraken.com/0/public/Depth?pair=' + encodeURIComponent(m.req) + '&count=500' : 'https://api.exchange.coinbase.com/products/' + encodeURIComponent(m.req) + '/book?level=2', last = 'error';
      for (var a = 0; a <= env.retries; a++) {
        if (env.now() - tStartRun > deadlineMs) return { miss: 'deadline' };
        var t0 = env.now();
        try {
          var j = await getJson(url), t1 = env.now(), ctx = { pair: m.pair, count: 500, requestStartUtc: iso(t0), receivedAtUtc: iso(t1) };
          if (venue === 'kraken') { if (j.error && j.error.length) throw new Error('api:' + j.error.join(',').slice(0, 40)); var k = Object.keys(j.result || {})[0]; if (!k) throw new Error('empty-result'); return { book: B.parseKraken(j.result[k], ctx), t0: t0, t1: t1, attempts: a + 1 }; }
          return { book: B.parseCoinbase(j, ctx), t0: t0, t1: t1, attempts: a + 1 };
        } catch (e) { last = e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 60); await env.sleep(e.status === 429 ? 5000 : 1500); }
      }
      return { miss: last };
    }
    // items: [{ m: mapping, sym }] already filtered to due pairs. Spacing >= minGapMs between request STARTS.
    async function sweepVenue(venue, items, o) {
      var tStart = env.now(), recs = [], misses = [], rejected = [], changes = [], scales = {}, last = 0, deadline = o.deadlineMs || DEADLINE_MS;
      for (var i = 0; i < items.length; i++) {
        var wait = last + env.minGapMs - env.now(); if (wait > 0) await env.sleep(wait); last = env.now();
        var it = items[i], m = it.m;
        if (env.now() - tStart > deadline) { for (var j = i; j < items.length; j++) misses.push({ venue: venue, pair: items[j].m.pair, reason: 'deadline' }); break; }
        var r = await requestOne(venue, m, tStart, deadline);
        if (r.miss) { misses.push({ venue: venue, pair: m.pair, reason: r.miss }); continue; }
        var b = r.book; if (b.mid == null) { var er = B.buildRecord(b, B.makeGrid(1, null, null, venue, m.pair)); er.recvMs = r.t1; recs.push(er); scales[venue + '|' + m.pair] = C.scaleFor(m.tick || 0.01, m.lot || 1e-8, m.quote); continue; }
        var gg = ensureGrid(o.gridState, venue, m, b.mid, env.now()); if (gg.change) changes.push(Object.assign({ venue: venue, pair: m.pair }, gg.change));
        var rec = B.buildRecord(b, gg.grid, { intervals: o.intervals ? o.intervals(it.sym, b) : [], maxTerms: 0 }); rec.recvMs = r.t1; rec.attempts = r.attempts;
        scales[venue + '|' + m.pair] = C.scaleFor(m.tick || 0.01, m.lot || 1e-8, m.quote); recs.push(rec);
      }
      return { venue: venue, startedAt: iso(tStart), endedAt: iso(env.now()), records: recs, misses: misses, gridChanges: changes, scales: scales, requested: items.length };
    }
    // encode + self-check (decode and compare every record; a mismatch becomes a recorded rejection, never a silent drop)
    function buildBatch(sweep, meta) {
      var enc = C.encodeBatch(sweep.records, sweep.scales, null), dec = C.decodeBatch(enc.batch), rejected = enc.rejected.slice(), ok = [], idx = 0, okIds = {};
      sweep.records.forEach(function (r) { if (enc.rejected.some(function (x) { return x.id === r.id; })) return; var d = dec[idx++], c = C.compare(r, d, null); if (c.bad.length) rejected.push({ id: r.id, reason: 'codec-mismatch', msg: c.bad.slice(0, 2).join(';') }); else okIds[r.id] = 1; });
      var keep = sweep.records.filter(function (r) { return okIds[r.id]; }), enc2 = rejected.length > enc.rejected.length ? C.encodeBatch(keep, sweep.scales, null) : enc;
      enc2.batch.meta = Object.assign({}, meta, { venue: sweep.venue, startedAt: sweep.startedAt, endedAt: sweep.endedAt, requested: sweep.requested, records: enc2.batch.r.length, misses: sweep.misses, rejected: rejected, gridChanges: sweep.gridChanges, schema: C.SCHEMA, grid: B.GRID_VERSION, codec: C.CODEC_VERSION });
      return enc2.batch;
    }
    return { getJson: getJson, requestOne: requestOne, sweepVenue: sweepVenue, buildBatch: buildBatch };
  }
  // ---- Node runner ----
  function readJson(fs, p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
  function loadInputs(fs, path, rootDir) {
    var ld = readJson(fs, path.join(rootDir, 'data', 'latest-daily.json')) || {}, coins = (ld.coins || []).filter(function (c) { return c && c.cgId && c.symbol; });
    var dailyDir = path.join(rootDir, 'data', 'daily'), daily = null; try { var names = fs.readdirSync(dailyDir).filter(function (n) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(n); }).sort(); if (names.length) daily = readJson(fs, path.join(dailyDir, names[names.length - 1])); } catch (e) { daily = null; }
    var verdict = {}; ((daily && daily.coins) || coins).forEach(function (c) { if (c && c.cgId) verdict[c.cgId] = c.research && c.research.verdict; });
    var orders = [], gen = null, cur = readJson(fs, path.join(rootDir, 'data', 'forward', 'CURRENT'));
    if (cur && cur.generationId) { gen = cur.generationId; var o = readJson(fs, path.join(rootDir, 'data', 'forward', 'gen-' + cur.generationId, 'orders.json')); orders = (o && o.orders) || []; }
    var hold = readJson(fs, path.join(rootDir, 'data', 'book', 'holdings.json')), holdings = hold && Array.isArray(hold.symbols) ? hold.symbols : [];
    return { coins: coins.map(function (c) { return { cgId: c.cgId, symbol: c.symbol, verdict: verdict[c.cgId] }; }), orders: orders, holdings: holdings, captureId: (daily && daily.captureId) || ld.captureId || null, generationId: gen, dailyDate: (daily && daily.date) || ld.date || null };
  }
  async function run(opts) {
    var fs = opts.fs || require('fs'), path = opts.path || require('path'), zlib = opts.zlib || require('zlib'), crypto = opts.crypto || require('crypto'), nowMs = opts.nowMs || Date.now(), out = { ok: false, error: null };
    var outDir = opts.outDir, slot = Math.floor(nowMs / Q15) * Q15, slotIso = iso(slot);
    function write(rel, data) { var p = path.join(outDir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; }
    try {
      var inp = loadInputs(fs, path, opts.root), col = create({ fetch: opts.fetch, now: opts.now || function () { return Date.now(); }, sleep: opts.sleep, minGapMs: opts.minGapMs, retries: opts.retries });
      var symbols = inp.coins.map(function (c) { return String(c.symbol).toUpperCase(); }).filter(function (s, i, a) { return a.indexOf(s) === i; });
      if (!symbols.length) throw new Error('universe unreadable (data/latest-daily.json)');
      var kp = (await col.getJson('https://api.kraken.com/0/public/AssetPairs')).result, cp = await col.getJson('https://api.exchange.coinbase.com/products'), mapping = mapPairs(symbols, kp, cp);
      var prevCad = (readJson(fs, path.join(opts.stateDir || '.', 'book', 'cadence.json')) || {}).table || [], gridState = (readJson(fs, path.join(opts.stateDir || '.', 'book', 'grids.json')) || {}).grids || {};
      var members = membership(inp), cad = updateCadence(prevCad, mapping, members, slot), symByCg = {}; inp.coins.forEach(function (c) { symByCg[c.cgId] = String(c.symbol).toUpperCase(); });
      var meta = { runId: slotIso, slot: slotIso, captureId: inp.captureId, generationId: inp.generationId, dailyDate: inp.dailyDate, cadenceVersion: cadenceVersion(cad.table), cadenceChanges: cad.changes.length, mapped: { kraken: mapping.kraken.length, coinbase: mapping.coinbase.length, unmapped: mapping.unmapped } };
      var results = await Promise.all(['kraken', 'coinbase'].map(function (v) {
        var items = mapping[v].filter(function (m) { return dueNow(cad.table, v, m.pair, slot); }).map(function (m) { return { m: m, sym: m.sym }; });
        return col.sweepVenue(v, items, { gridState: gridState, deadlineMs: opts.deadlineMs, intervals: function (sym) { return intervalsFor(inp.orders, symByCg, sym); } }).then(function (sw) { return { v: v, sw: sw, items: items.length }; });
      }));
      var pub = { slot: slotIso, meta: meta, batches: [] };
      results.forEach(function (r) {
        var batch = col.buildBatch(r.sw, meta), gz = zlib.gzipSync(Buffer.from(C.serializeBatch(batch), 'utf8'), { level: 9 }), rel = 'book/' + r.v + '/' + slotIso.slice(0, 10) + '/' + slotIso.slice(11, 13) + slotIso.slice(14, 16) + '.json.gz';
        write(path.join('batches', rel), gz); pub.batches.push({ venue: r.v, path: rel, version: slotIso, sha256: crypto.createHash('sha256').update(gz).digest('hex'), gzBytes: gz.length, rawBytes: Buffer.byteLength(C.serializeBatch(batch)), records: batch.r.length, misses: r.sw.misses.length, rejected: batch.meta.rejected.length });
      });
      write('state/book/cadence.json', JSON.stringify({ version: meta.cadenceVersion, updatedAt: slotIso, table: cad.table }));
      write('state/book/grids.json', JSON.stringify({ updatedAt: slotIso, grids: gridState }));
      write('publication.json', JSON.stringify(pub, null, 1)); out.ok = true; out.pub = pub;
    } catch (e) { out.error = String(e && e.message || e); try { write('FAILED.json', JSON.stringify({ at: iso(nowMs), error: out.error })); } catch (e2) { /* advisory */ } }
    return out;
  }
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    var a = process.argv.slice(2), arg = function (k, d) { var i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
    run({ root: arg('--root', '.'), stateDir: arg('--state', null), outDir: arg('--out', 'out'), nowMs: arg('--now') ? Date.parse(arg('--now')) : Date.now(), fetch: function (u, o) { return fetch(u, Object.assign({ headers: { 'User-Agent': 'radar-book/1.0' } }, o)); } })
      .then(function (o) { console.log('book-collector: ' + (o.ok ? 'ok ' + o.pub.batches.map(function (b) { return b.venue + ' ' + b.records + ' rec, ' + b.misses + ' miss, ' + b.gzBytes + ' B gz'; }).join('; ') : 'FAILED (advisory, exit 0): ' + o.error)); process.exit(0); });
  }
  return { mapPairs: mapPairs, membership: membership, activeOrder: activeOrder, updateCadence: updateCadence, cadenceVersion: cadenceVersion, dueNow: dueNow, ensureGrid: ensureGrid, intervalsFor: intervalsFor, create: create, loadInputs: loadInputs, run: run, Q15: Q15, H1: H1 };
});
