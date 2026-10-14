'use strict';
// item 52e A5: grid v3 acceptance. Existing suites (core/codec/collector/publish) run UNCHANGED; this file adds the v2-vs-v3 cases.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const B = require('./book-core.js'), C = require('./book-codec.js'), K = require('./book-collector.js');
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + ': ' + e.message); } }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion'); }
function near(a, b, e, m) { if (Math.abs(a - b) > (e || 1e-9)) throw new Error((m || '') + ' got ' + a + ' want ' + b); }
const ctx = (pair, over) => Object.assign({ pair: pair || 'X/USD', count: 500, requestStartUtc: '2026-10-14T10:00:00.000Z', receivedAtUtc: '2026-10-14T10:00:00.300Z' }, over || {});
const kb = (bids, asks, c) => B.parseKraken({ bids: bids.map(x => [String(x[0]), String(x[1]), 1760000000]), asks: asks.map(x => [String(x[0]), String(x[1]), 1760000000]) }, ctx('X/USD', c));
const ladder = (start, step, n, size) => { const a = []; for (let i = 0; i < n; i++) a.push([Number((start + step * i).toFixed(6)), size]); return a; };
const G2 = (a) => B.makeGrid(a || 100, 0.01, '2026-10', 'kraken', 'X/USD', 2), G3 = (a) => B.makeGrid(a || 100, 0.01, '2026-10', 'kraken', 'X/USD', 3);
function richBook() {
  const bids = ladder(99.9, -0.1, 150, 1).concat([[95, 500]]), asks = ladder(100.1, 0.1, 150, 1).concat([[105, 500], [118, 50], [125, 50], [135, 50], [150, 50]]);
  return kb(bids, asks);
}
const FX = __dirname + '/fixtures/';
const FROZEN = { kraken: 'e0ff2648438dabf2', coinbase: '6a42d575cb1c2e72' };   // sha256[:16] of JSON.stringify(decodeBatch(batch)) produced by the UNCHANGED 52b codec (1e40d336) before 52e

(async () => {
  await t('makeGrid default stays v2 (legacy callers); v3 only when asked; unknown versions throw', () => {
    const d = B.makeGrid(100, 0.01, 'P', 'kraken', 'X/USD'); eq(d.version, 2); eq(B.gridId(d), 'kraken|X/USD|100|v2'); eq(d.bins, 82);
    const g = G3(); eq(g.version, 3); eq(B.gridId(g), 'kraken|X/USD|100|v3'); eq(g.bins, 102); eq(g.edges.length, 101); eq(B.CURRENT_GRID_VERSION, 3);
    let threw = false; try { B.makeGrid(100, 0.01, 'P', 'k', 'X', 4); } catch (e) { threw = true; } ok(threw);
  });
  await t('v2 id reconstructs v2 bounds exactly; v3 id reconstructs v3 (version-aware gridOf / gridFromId / binBounds by id)', () => {
    const a = B.gridOf('kraken|X/USD|100|v2'), b = B.gridOf('kraken|X/USD|100|v3'); eq(a.version, 2); eq(a.edges.length, 81); near(a.edges[80], 120); eq(b.version, 3); eq(b.edges.length, 101); near(b.edges[100], 140);
    eq(a.edges, G2().edges, 'v2 edges identical to the original constructor'); eq(B.gridFromId('kraken|X/USD|100|v3').version, 3); eq(B.gridFromId('kraken|X/USD|100|v2').version, 2);
    eq(B.binBounds('kraken|X/USD|100|v2', 81), { lo: a.edges[80], hi: null }); eq(B.binBounds('kraken|X/USD|100|v3', 81), { lo: b.edges[80], hi: b.edges[81] });
    eq(B.gridOf('kraken|X/USD|100|v4'), null); eq(B.gridOf('garbage'), null);
  });
  await t('bid side and bins up to +20 % are identical in v2 and v3 (same edges, same indices)', () => {
    const a = G2(), b = G3(); eq(b.edges.slice(0, 81), a.edges); eq(b.edgesBp.slice(0, 81), a.edgesBp);
    [60, 79.99, 80, 95, 99.9, 100, 100.2, 104.99, 105, 109.99, 110, 119.99].forEach(p => eq(B.binIndex(a, p), B.binIndex(b, p), 'price ' + p));
  });
  await t('v3 ask bounds: 1 % bins at +20/+21/.../+40, tail beyond +40', () => {
    const g = G3(); for (let k = 0; k < 20; k++) { const i = 81 + k, bd = B.binBounds(g, i); near(bd.lo, 120 + k, 1e-9, 'lo ' + k); near(bd.hi, 121 + k, 1e-9, 'hi ' + k); eq(B.binIndex(g, 120 + k + 0.5), i, 'idx ' + k); }
    eq(B.binIndex(g, 120), 81); eq(B.binIndex(g, 140), 101); eq(B.binIndex(g, 139.999), 100); eq(B.binBounds(g, 101), { lo: g.edges[100], hi: null }); near(g.edges[100], 140);
  });
  await t('tail aggregation beyond +40 %; v2 tail mass = sum of v3 bins 81..101', () => {
    const bk = kb([[99, 1]], [[101, 1], [125.5, 2], [139.9, 3], [141, 4], [500, 5]]), a2 = B.aggregate(bk, G2()), a3 = B.aggregate(bk, G3());
    near(a3.a[101].quote, 141 * 4 + 500 * 5, 1e-6); near(a3.a[B.binIndex(G3(), 125.5)].quote, 125.5 * 2, 1e-6); near(a3.a[100].quote, 139.9 * 3, 1e-6);
    let sum3 = 0; for (let i = 81; i <= 101; i++) if (a3.a[i]) sum3 += a3.a[i].quote; near(a2.a[81].quote, sum3, 1e-6); near(a2.a[81].quote, 125.5 * 2 + 139.9 * 3 + 141 * 4 + 2500, 1e-6);
  });
  await t('capReached and farthest unchanged by the grid version', () => {
    const bk = kb(ladder(99, -0.5, 3, 1), ladder(101, 0.5, 3, 1), { count: 3 }), r2 = B.buildRecord(bk, G2()), r3 = B.buildRecord(bk, G3());
    eq(r3.capReached, r2.capReached); eq(r3.capReached, { b: true, a: true }); eq(r3.farthest, r2.farthest); eq(r3.farthestPct, r2.farthestPct); eq(r3.levels, r2.levels);
    eq(B.sideCoverage(bk, 'a', 130), 'lowerBound'); eq(B.sideCoverage(bk, 'a', 102), 'complete');
  });
  await t('same raw book under v2 and v3: q3/q5/q8, denominators, depth, intervals, TEST/A4-facing fields identical', () => {
    const bk = richBook(), iv = [{ side: 'a', lo: 100.1, hi: 118, name: 'L->T:x' }, { side: 'b', lo: 95, hi: 99.9, name: 'L->S:x' }], r2 = B.buildRecord(bk, G2(), { intervals: iv, maxTerms: 0 }), r3 = B.buildRecord(bk, G3(), { intervals: iv, maxTerms: 0 });
    ok(r2.walls.q5.length > 0, 'fixture must contain q5 walls'); eq(r3.walls, r2.walls, 'walls (q3/q5/q8/denominator/coverage/reliable)'); eq(r3.depth, r2.depth); eq(r3.intervals, r2.intervals); eq(r3.bins.b, r2.bins.b);
    eq(r3.bins.a.filter(x => x[0] <= 80), r2.bins.a.filter(x => x[0] <= 80)); ['mid', 'bestBid', 'bestAsk', 'spread', 'spreadPct', 'farthest', 'farthestPct', 'levels', 'capReached', 'quote', 'venue', 'pair', 'id', 'req', 'recv'].forEach(k => eq(r3[k], r2[k], k));
    eq(r2.grid, 'kraken|X/USD|100|v2'); eq(r3.grid, 'kraken|X/USD|100|v3'); ok(r3.bins.a.some(x => x[0] > 81), 'v3 resolves asks beyond +20 %');
    const keys = o => Object.keys(o).sort(); eq(keys(r3), keys(r2));
  });
  await t('q5 lists stay identical across a spread of mids and tail-heavy books', () => {
    [97, 100, 103].forEach(m => { const bk = kb(ladder(m - 0.1, -0.1, 140, 1).concat([[m * 0.93, 300]]), ladder(m + 0.1, 0.1, 140, 1).concat([[m * 1.06, 300], [m * 1.3, 900], [m * 1.5, 900]])), r2 = B.buildRecord(bk, G2()), r3 = B.buildRecord(bk, G3());
      eq(r3.walls.q5, r2.walls.q5, 'q5 @' + m); eq(r3.walls.q3, r2.walls.q3); eq(r3.walls.q8, r2.walls.q8); eq(r3.walls.denominator, r2.walls.denominator); });
  });
  await t('windowStats: v3-only window equals v2-only window; mixed v2/v3 stays grid-mismatch (unchanged rule)', () => {
    const mk = (G, ver, n) => { const out = []; for (let i = 0; i < n; i++) { const r = B.buildRecord(kb(ladder(99.9, -0.1, 140, 1).concat([[95, 500]]), ladder(100.1, 0.1, 140, 1).concat([[105, 500]]), { requestStartUtc: '2026-10-14T10:' + String(i * 15).padStart(2, '0') + ':00.000Z' }), G); r.recvMs = Date.UTC(2026, 9, 14, 10, i * 15, 0); out.push(r); } return out; };
    const o = { cutoffMs: Date.UTC(2026, 9, 14, 11, 0, 0), windowMs: 3600000, cadenceMs: 900000, minCoverage: 0.5, maxAgeMs: 1800000, wallKey: 'q5' }, w2 = B.windowStats(mk(G2(), 2, 4), o), w3 = B.windowStats(mk(G3(), 3, 4), o);
    eq(w3.status, 'ok'); eq(w3.bins, w2.bins); eq(w3.observed, w2.observed); eq(w3.expected, w2.expected);
    const mixed = mk(G2(), 2, 2).concat(mk(G3(), 3, 4).slice(2)); eq(B.windowStats(mixed, o).reason, 'grid-mismatch');
  });
  await t('wallTransition reconstructs by the record\'s own version (v3 persisted; v3 outside-region; v2 still works)', () => {
    [[G2, 'v2'], [G3, 'v3']].forEach(([G, v]) => {
      const mk = (mid, min, off) => { const bk = kb(ladder(mid - 0.1, -0.1, 140, 1).concat([[95, 500]]), ladder(mid + 0.1, 0.1, 140, 1).concat(min ? [[105, 500]] : []), { requestStartUtc: new Date(Date.UTC(2026, 9, 14, 10, 0, 0) + off).toISOString() }), r = B.buildRecord(bk, G()); r.recvMs = Date.UTC(2026, 9, 14, 10, 0, 0) + off; return r; };
      const r0 = mk(100, true, 0), r1 = mk(100, true, 900000), w0 = r0.walls.q5.filter(w => w[0] === 'a')[0]; ok(w0, 'ask wall at t0 (' + v + ')');
      eq(B.wallTransition([r0, r1], { t0Ms: r0.recvMs, side: 'a', idx: w0[1], horizonMs: 900000, toleranceMs: 0, wallKey: 'q5' }).outcome, 'persisted');
      const r2 = mk(140, false, 900000); eq(B.wallTransition([r0, r2], { t0Ms: r0.recvMs, side: 'a', idx: w0[1], horizonMs: 900000, toleranceMs: 0, wallKey: 'q5' }).outcome, 'outside-region', v);
    });
  });
  await t('codec: schema/codec versions unchanged; v3 records round-trip within the declared tolerance; grid id carried', () => {
    eq(C.CODEC_VERSION, 1); eq(C.SCHEMA, 2); const r = B.buildRecord(richBook(), G3(), { intervals: [{ side: 'a', lo: 100.1, hi: 130, name: 'L->T:x' }], maxTerms: 0 }), enc = C.encodeBatch([r], { 'kraken|X/USD': { pd: 2, bd: 8, quote: 'USD' } }, null);
    eq(enc.rejected, []); const d = C.decodeBatch(JSON.parse(JSON.stringify(enc.batch)))[0]; eq(C.compare(r, d, null).bad, []); eq(d.grid, 'kraken|X/USD|100|v3'); eq(enc.batch.grids, ['kraken|X/USD|100|v3']);
    ok(d.bins.a.some(x => x[0] >= 81 && x[0] <= 101));
    eq(d.walls.q5.map(w => w[0] + w[1]).sort(), r.walls.q5.map(w => w[0] + w[1]).sort());
  });
  await t('REAL 10-14T14:00Z batches (kraken 88, coinbase 75 records): decode byte-identical to the pre-52e codec; every record is a v2 grid reconstructed by its own version', () => {
    ['kraken', 'coinbase'].forEach(v => {
      const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(FX + 'v2-' + v + '-2026-10-14T1400.json.gz'))), recs = C.decodeBatch(b), h = crypto.createHash('sha256').update(JSON.stringify(recs)).digest('hex').slice(0, 16);
      eq(h, FROZEN[v], v + ' decode hash'); ok(recs.length > 50);
      recs.forEach(r => { ok(/\|v2$/.test(r.grid), r.grid); const g = B.gridOf(r.grid); eq(g.version, 2); ok(g.edges.length === 81); if (r.bins) r.bins.a.forEach(x => { ok(x[0] <= 81, 'ask bin idx ' + x[0] + ' in ' + r.id); const bd = B.binBounds(r.grid, x[0]); ok(bd.lo != null || x[0] === 0); }); });
    });
  });
  await t('ensureGrid: first -> v3; v2 entry upgraded in place (same anchor/period, recorded); period-start and drift -> fresh v3; v3 entry reused; direct legacy call stays v2', () => {
    const m = { pair: 'ETH/USD', tick: 0.01 }, n1 = Date.UTC(2026, 9, 14, 12, 0, 0), st = {};
    let g = K.ensureGrid(st, 'kraken', m, 2500, n1, 3); eq(B.gridId(g.grid), 'kraken|ETH/USD|2500|v3'); eq(g.change.reason, 'first'); eq(st['kraken|ETH/USD'].version, 3);
    g = K.ensureGrid(st, 'kraken', m, 2510, n1 + 1000, 3); eq(g.change, null); eq(B.gridId(g.grid), 'kraken|ETH/USD|2500|v3');
    const st2 = { 'kraken|ETH/USD': { anchor: 2505.27, tick: 0.01, period: '2026-10', createdAt: '2026-10-14T01:56:22.288Z' } };
    g = K.ensureGrid(st2, 'kraken', m, 2510, n1, 3); eq(g.change.reason, 'grid-v3'); eq(g.change.from, 'kraken|ETH/USD|2505.27|v2'); eq(g.change.to, 'kraken|ETH/USD|2505.27|v3'); eq(st2['kraken|ETH/USD'].anchor, 2505.27); eq(st2['kraken|ETH/USD'].createdAt, '2026-10-14T01:56:22.288Z'); eq(st2['kraken|ETH/USD'].version, 3);
    g = K.ensureGrid(st2, 'kraken', m, 2511, n1 + 5000, 3); eq(g.change, null);
    const st3 = { 'kraken|ETH/USD': { anchor: 2505.27, tick: 0.01, period: '2026-10' } }; g = K.ensureGrid(st3, 'kraken', m, 3000, n1, 3); eq(g.change.reason, 'drift>15%'); eq(B.gridId(g.grid), 'kraken|ETH/USD|3000|v3'); eq(g.change.from, 'kraken|ETH/USD|2505.27|v2');
    const st4 = { 'kraken|ETH/USD': { anchor: 2505.27, tick: 0.01, period: '2026-09' } }; g = K.ensureGrid(st4, 'kraken', m, 2510, n1, 3); eq(g.change.reason, 'period-start'); eq(st4['kraken|ETH/USD'].version, 3);
    const st5 = { 'kraken|ETH/USD': { anchor: 2505.27, tick: 0.01, period: '2026-10' } }; g = K.ensureGrid(st5, 'kraken', m, 2510, n1); eq(g.change, null); eq(B.gridId(g.grid), 'kraken|ETH/USD|2505.27|v2');
  });
  await t('sweepVenue: new snapshots are v3; grids.json state entry gains version 3; a v2 entry upgrades and the record carries the v3 id', async () => {
    let now = Date.UTC(2026, 9, 14, 12, 0, 0); const clock = { now: () => now, sleep: async ms => { now += ms; } };
    const fetch = async () => ({ ok: true, json: async () => ({ error: [], result: { X: { bids: [['99.9', '5', 1], ['95', '50', 1]], asks: [['100.1', '5', 1], ['125', '40', 1]] } } }) });
    const col = K.create({ fetch, now: clock.now, sleep: clock.sleep, minGapMs: 0 }), m = { req: 'AUSD', pair: 'A/USD', tick: 0.01, lot: 1e-8, quote: 'USD' };
    const gs = {}, sw = await col.sweepVenue('kraken', [{ sym: 'A', m }], { gridState: gs });
    eq(sw.records[0].grid, 'kraken|A/USD|100|v3'); eq(gs['kraken|A/USD'].version, 3); eq(sw.gridChanges[0].reason, 'first');
    const gs2 = { 'kraken|A/USD': { anchor: 100, tick: 0.01, period: '2026-10', createdAt: 'x' } }, sw2 = await col.sweepVenue('kraken', [{ sym: 'A', m }], { gridState: gs2 });
    eq(sw2.records[0].grid, 'kraken|A/USD|100|v3'); eq(sw2.gridChanges[0].reason, 'grid-v3'); eq(gs2['kraken|A/USD'].version, 3);
    const b = col.buildBatch(sw, { slot: 's' }); eq(b.meta.rejected, []); eq(b.meta.gridCurrent, 3); eq(b.grids, ['kraken|A/USD|100|v3']); ok(C.decodeBatch(b)[0].bins.a.some(x => x[0] === B.binIndex(G3(), 125)), 'ask at +25 % lands in its own 1 % bin');
  });
  console.log('book-v3 tests: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
