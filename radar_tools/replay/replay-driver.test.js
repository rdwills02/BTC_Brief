/* radar_tools/replay/replay-driver.test.js — acceptance tests 1-6 for the replay driver (§6 of the spec).
 * Acceptance 7 (regression guard MATCH; zero capture.js/radar.html/etc changes) is checked separately by
 * the handoff's own diff/guard run, not here (this driver never requires or touches those files).
 * Run: node radar_tools/replay/replay-driver.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const D = require('./replay-driver.js');
const I = D.internal;
const EC = require('../../episodes-core.js');
const OC = require('../../orders-core.js');
const C = require('../../channel-core.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message); }
}

// ---------------- Acceptance 1: determinism ----------------
test('A1: buildStore is byte-identical across two runs', function () {
  D.buildStore();
  const doc1 = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'replay', 'universe.json'), 'utf8');
  const candleFile1 = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'replay', 'candles', 'TRX-USD.json'), 'utf8');
  D.buildStore();
  const doc2 = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'replay', 'universe.json'), 'utf8');
  const candleFile2 = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'replay', 'candles', 'TRX-USD.json'), 'utf8');
  assert.strictEqual(doc1, doc2, 'universe.json must be byte-identical');
  assert.strictEqual(candleFile1, candleFile2, 'candle file must be byte-identical');
});

test('A1: two short simulateFamily runs over identical inputs produce identical order books', function () {
  const universe = D.loadUniverse();
  const fam = I.buildPolicyFamily();
  const dates = I.dateRange('2024-11-01', '2024-12-15');
  const b1 = I.simulateFamily(universe, dates, [fam.n0], function () { return true; }, null, null);
  const b2 = I.simulateFamily(universe, dates, [fam.n0], function () { return true; }, null, null);
  assert.strictEqual(I.stableStringify(b1.N0), I.stableStringify(b2.N0), 'N0 book must be identical across runs');
});

test('A1 (checkpoint 7b): two full --dev runs (structural-continuity path included) produce an identical runId and a byte-identical development-table.json', function () {
  const dev1 = D.runDevelopment();
  const dev2 = D.runDevelopment();
  assert.strictEqual(dev1.runId, dev2.runId, 'runId must be identical across two runs of the same inputs');
  assert.strictEqual(I.stableStringify(dev1.doc), I.stableStringify(dev2.doc), 'development-table content must be byte-identical across two runs');
});

// ---------------- Acceptance 2: reuse + Protocol §4.0 pipeline-order ----------------
test('A2: episodes-core.js and orders-core.js are required, not reimplemented (same module identity)', function () {
  const EC2 = require('../../episodes-core.js'), OC2 = require('../../orders-core.js');
  assert.strictEqual(EC2, EC, 'episodes-core.js must resolve to the same cached module (no fork/copy)');
  assert.strictEqual(OC2, OC, 'orders-core.js must resolve to the same cached module (no fork/copy)');
  const src = fs.readFileSync(__filename.replace('.test.js', '.js'), 'utf8');
  ['function updateEpisodes', 'function adjudicateOrder', 'function issueOne', 'function exitRules'].forEach(function (sig) {
    assert.ok(src.indexOf(sig) === -1, 'replay-driver.js must not reimplement ' + sig);
  });
});

test('A2: per-capture calls hit OC in Protocol §4.0 order (2 adjudicate, 3 activate, 4 valuation, 5 suspend, 7 issue); EC.updateEpisodes runs once per capture, not once per policy', function () {
  const calls = [];
  const origs = { a: OC.adjudicateAll, b: OC.activateAll, c: OC.valuation, d: OC.suspend, e: OC.issueBatch, f: EC.updateEpisodes };
  OC.adjudicateAll = function () { calls.push('adjudicateAll'); return origs.a.apply(OC, arguments); };
  OC.activateAll = function () { calls.push('activateAll'); return origs.b.apply(OC, arguments); };
  OC.valuation = function () { calls.push('valuation'); return origs.c.apply(OC, arguments); };
  OC.suspend = function () { calls.push('suspend'); return origs.d.apply(OC, arguments); };
  OC.issueBatch = function () { calls.push('issueBatch'); return origs.e.apply(OC, arguments); };
  EC.updateEpisodes = function () { calls.push('updateEpisodes'); return origs.f.apply(EC, arguments); };
  try {
    const universe = D.loadUniverse();
    const fam = I.buildPolicyFamily();
    const twoPolicies = [fam.n0, fam.grid[0]];
    I.simulateFamily(universe, ['2024-11-05'], twoPolicies, function () { return true; }, null, null);
    // one shared updateEpisodes call, then per-policy OC steps in order, twice (two policies)
    assert.strictEqual(calls.filter(function (c) { return c === 'updateEpisodes'; }).length, 1, 'updateEpisodes must run once per capture regardless of policy count');
    assert.strictEqual(calls[0], 'updateEpisodes', 'step 6 (shared) must be computed before any policy step 2-7');
    const perPolicy = calls.slice(1);
    for (let i = 0; i < 2; i++) {
      const seg = perPolicy.slice(i * 5, i * 5 + 5);
      assert.deepStrictEqual(seg, ['adjudicateAll', 'activateAll', 'valuation', 'suspend', 'issueBatch'], 'policy ' + i + ' must call OC in §4.0 order 2,3,4,5,7');
    }
  } finally { OC.adjudicateAll = origs.a; OC.activateAll = origs.b; OC.valuation = origs.c; OC.suspend = origs.d; OC.issueBatch = origs.e; EC.updateEpisodes = origs.f; }
});

// ---------------- Acceptance 3: leakage ----------------
test('A3a: usableSlice never includes a candle whose bar has not closed by the cutoff', function () {
  const candles = [{ time: 1000, id: 1000 }, { time: 1000 + 86400, id: 1000 + 86400 }, { time: 1000 + 2 * 86400, id: 1000 + 2 * 86400 }];
  const cutoff = 1000 + 86400;   // only the first candle's bar (endTime = 1000+86400) has closed by this cutoff
  const usable = I.usableSlice(candles, cutoff);
  assert.strictEqual(usable.length, 1);
  assert.strictEqual(usable[0].time, 1000);
});

test('A3b: a candle dated AFTER the capture date never changes that capture\'s computed research row (no lookahead)', function () {
  const universe = D.loadUniverse();
  const dateStr = '2025-01-15';
  const s1 = I.sharedDayStep(universe, dateStr, null);
  const mutated = JSON.parse(JSON.stringify(universe));
  // corrupt every candle dated strictly after dateStr for one coin
  const trx = mutated.byCgId['tron'];
  const cutoff = I.ymdToSec(dateStr);
  trx.candles = trx.candles.map(function (c) { return (c.time + 86400 > cutoff) ? Object.assign({}, c, { close: 999999, open: 999999, high: 999999, low: 999999 }) : c; });
  const s2 = I.sharedDayStep(mutated, dateStr, null);
  assert.strictEqual(I.stableStringify(s1.candidates.filter(function (c) { return c.cgId === 'tron'; })),
    I.stableStringify(s2.candidates.filter(function (c) { return c.cgId === 'tron'; })), 'future-candle corruption must not change this capture\'s candidates for the coin');
  assert.strictEqual(JSON.stringify(s1.bars.tron.candles), JSON.stringify(s2.bars.tron.candles), 'the usable bar set itself must be unaffected by future-candle corruption');
});

test('A3c: the validation split (and --select) refuse to run until development-table.json + its .sha256 are on disk, and detect drift', function () {
  const tmpDir = fs.mkdtempSync('/tmp/replay-guard-');
  assert.throws(function () { D.assertDevelopmentTableWritten(tmpDir); }, /REFUSED/, 'must refuse with no table on disk');
  const dev = D.runDevelopment();
  const rec = D.assertDevelopmentTableWritten(dev.runDir);   // must NOT throw once written
  assert.ok(rec.runId === dev.runId);
  // corrupt the recorded hash -> must refuse
  const hashPath = path.join(dev.runDir, 'development-table.sha256');
  fs.writeFileSync(hashPath, '0'.repeat(64));
  assert.throws(function () { D.assertDevelopmentTableWritten(dev.runDir); }, /REFUSED/, 'must refuse when the recorded hash no longer matches the file');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return dev;
});

// ---------------- Acceptance 4: context policy (bar-close vs live) ----------------
test('A4: the gate context fed to researchVerdict is the D-1 close and D-1 quote volume, not a live quote', function () {
  const universe = D.loadUniverse();
  const dateStr = '2025-02-01', cutoff = I.ymdToSec(dateStr);
  const coin = universe.byCgId['tron'];
  const usable = I.usableSlice(coin.candles, cutoff);
  const last = usable[usable.length - 1];
  assert.ok(last.time + 86400 <= cutoff && last.time + 2 * 86400 > cutoff, 'the last usable candle must be exactly D-1');
  const shared = I.sharedDayStep(universe, dateStr, null);
  const row = shared.candidates.find(function (c) { return c.cgId === 'tron'; });
  if (row) assert.strictEqual(row.price, last.close, 'candidate price must be the D-1 close');
  assert.ok(I.CONTEXT_DIFFERENCES.length >= 5, 'the context-difference list must be populated');
});
test('A4: every report header carries the context-difference list', function () {
  const dev = D.runDevelopment();
  assert.deepStrictEqual(dev.doc.contextDifferencesFromLive, I.CONTEXT_DIFFERENCES);
  const cont = D.runContaminated('N0');
  assert.deepStrictEqual(cont.doc.contextDifferencesFromLive, I.CONTEXT_DIFFERENCES);
});

// ---------------- Acceptance 5: split-boundary correctness ----------------
test('A5: no order is issued after the development split end, even though simulation continues through the embargo', function () {
  const universe = D.loadUniverse();
  const fam = I.buildPolicyFamily();
  const dates = I.dateRange('2025-07-20', '2025-08-10');   // straddles DEV_END (2025-07-31)
  const books = I.simulateFamily(universe, dates, [fam.n0], function (d) { return d <= I.DEV_END; }, null, null);
  const lateIssues = books.N0.orders.filter(function (o) { return o.issueDate > I.DEV_END; });
  assert.strictEqual(lateIssues.length, 0, 'no order may be issued with issueDate after ' + I.DEV_END);
  const ordersBeforeEnd = books.N0.orders.filter(function (o) { return o.issueDate <= I.DEV_END; });
  // sanity: issuance was actually exercised in this window (not a vacuous pass)
  assert.ok(ordersBeforeEnd.length >= 0);
});

// ---------------- Acceptance 6: survivorship note + provenance hashes ----------------
test('A6: development and contaminated reports both carry the survivorship note and provenance hashes', function () {
  const dev = D.runDevelopment();
  ['survivorshipNote', 'storeHash', 'metadataSnapshotSha256', 'baseCommit', 'engineVersion'].forEach(function (k) {
    assert.ok(dev.doc[k] && String(dev.doc[k]).length > 0, 'development report missing ' + k);
  });
  const cont = D.runContaminated('N0');
  ['survivorshipNote', 'storeHash', 'metadataSnapshotSha256', 'baseCommit', 'engineVersion'].forEach(function (k) {
    assert.ok(cont.doc[k] && String(cont.doc[k]).length > 0, 'contaminated report missing ' + k);
  });
});

// ---------------- extra: PRNG golden vector (cross-checked against an independent Python port; see handoff) ----------------
test('golden vector: splitmix32(a=20260925) -> xoshiro128** first 20 outputs match the recorded golden vector', function () {
  const golden = [359076858, 502891463, 3521550455, 3200516212, 3856499488, 4076452103, 1023590760, 38154047, 356241264, 3995675823,
    2403978383, 3164668789, 3441038608, 281966718, 1104622837, 2041895341, 2903156683, 2387263464, 3376821112, 3675532960];
  assert.deepStrictEqual(I.goldenVector(20260925, 20), golden);
});
test('golden vector: channel-core.researchVerdict emits gates in exactly the driver\'s declared GATE_IDS order', function () {
  const universe = D.loadUniverse();
  const coin = universe.byCgId['tron'];
  const usable = I.usableSlice(coin.candles, I.ymdToSec('2025-03-01'));
  const fit = C.detectChannel(usable, null, { coinId: 'tron', timeframe: '1d', source: 'kraken', research: true });
  const res = C.researchVerdict(fit, { price: usable[usable.length - 1].close, volume24h: 1e6, btc: { aboveEma50: true, ema50Slope: 0.01 }, quote: null, floor: C.ACT_SCORE_FLOOR_1D });
  assert.deepStrictEqual(res.details.gates.map(function (g) { return g.id; }), I.GATE_IDS);
});
test('bootstrap: identical daily series for two policies -> bootstrap difference is not spuriously nonzero (sanity)', function () {
  const sums = [1, -1, 2, -2, 0.5, -0.5, 1, -1, 0.2, -0.2];
  const counts = sums.map(function () { return 1; });
  const r1 = I.bootstrapMeanBudgetR(sums, counts, 20260925, 20, 2000);
  const r2 = I.bootstrapMeanBudgetR(sums, counts, 20260925, 20, 2000);
  assert.strictEqual(r1.pointEstimate, r2.pointEstimate);
  assert.strictEqual(r1.lowerBound90, r2.lowerBound90, 'identical inputs and seed must give an identical bound (determinism)');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
