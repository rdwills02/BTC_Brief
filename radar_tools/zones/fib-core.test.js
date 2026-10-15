/* fib-core.test.js — node fib-core.test.js
 * HAND-CHECKED FIXTURE (daily, time = T0 + i*86400): i 0..9 flat (high 20, low 18); i 10 high 19 low 10 (pivot low: 10 < the 5 lows before (18) and the 5 after (15));
 * i 11..15 high 21 low 15; i 16 high 40 low 20 (pivot high: 40 > the 5 highs before (21) and the 5 after (30)); i 17..N-1 high 30 low 22 (flat: ties produce no further pivots).
 * Leg: low 10 @T(10), high 40 @T(16), range 30. confirmedAt: low T(15)+D = T(16), high T(21)+D = T(22) -> leg.confirmedAt = T(22).
 * Levels: 0.618 -> 40-18.54 = 21.46 ; 0.705 -> 18.85 ; 0.786 -> 16.42 ; 1.272 -> 48.16 ; 1.618 -> 58.54 ; 0 -> 40 ; 1 -> 10. */
var F = require('./fib-core.js'), assert = require('assert'), n = 0;
function ok(c, m) { n++; if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } }
function eq(a, b, m) { n++; try { assert.deepStrictEqual(a, b); } catch (e) { console.error('FAIL: ' + m + '\n  got ' + JSON.stringify(a) + '\n  want ' + JSON.stringify(b)); process.exitCode = 1; } }
function near(a, b, m) { n++; if (!(Math.abs(a - b) < 1e-9)) { console.error('FAIL: ' + m + ' got ' + a + ' want ' + b); process.exitCode = 1; } }
var T0 = 1700006400, D = 86400, T = function (i) { return T0 + i * D; }, NOW = T(60) * 1000, O = { intervalSec: D, nowMs: NOW };
function fix(N) {
  var cs = []; for (var i = 0; i < N; i++) cs.push({ time: T(i), open: 19, high: 20, low: 18, close: 19, volume: 100 });
  cs[10] = { time: T(10), open: 15, high: 19, low: 10, close: 15, volume: 100 };
  for (i = 11; i <= 15 && i < N; i++) cs[i] = { time: T(i), open: 18, high: 21, low: 15, close: 18, volume: 100 };
  if (N > 16) cs[16] = { time: T(16), open: 22, high: 40, low: 20, close: 35, volume: 100 };
  for (i = 17; i < N; i++) cs[i] = { time: T(i), open: 25, high: 30, low: 22, close: 25, volume: 100 };
  return cs;
}
var r = F.compute(fix(26), O, {});
eq(r.status, 'ok', 'leg available on the hand-checked fixture');
eq(r.leg, { lowTime: T(10), low: 10, highTime: T(16), high: 40, confirmedAt: T(22) }, 'leg selection: most recent confirmed low, highest confirmed pivot high after it; confirmedAt = later confirmation');
var want = { 0: 40, 0.618: 21.46, 0.705: 18.85, 0.786: 16.42, 1: 10, 1.272: 48.16, 1.618: 58.54 };
eq(r.levels.map(function (l) { return l.ratio; }), [0, 0.618, 0.705, 0.786, 1, 1.272, 1.618], 'levels: reference 0, three retracements, reference 1, two extensions');
r.levels.forEach(function (l) { near(l.price, want[l.ratio], 'level ' + l.ratio + ' arithmetic'); });
eq(r.levels.map(function (l) { return l.kind; }), ['ref', 'retracement', 'retracement', 'retracement', 'ref', 'extension', 'extension'], 'level kinds');
/* confluence: +-1 % of 21.46 = [21.2454, 21.6746] */
var ctx = { entry: { low: 21.3, high: 21.6 }, stop: 21.25, target: 58.6,
  demand: [{ id: 'hd1-1', bottom: 16.0, top: 16.5 }, { id: 'hd1-2', bottom: 30, top: 31 }], supply: [{ id: 'hs1-1', bottom: 48, top: 49 }, { id: 'hs1-2', bottom: 21.6746, top: 22 }],
  sell: [{ lo: 18.9, hi: 19.0, venue: 'Coinbase', usd: 35000 }, { lo: 25, hi: 26, venue: 'Kraken', usd: 9000 }] };
var rc = F.compute(fix(26), O, ctx), by = {}; rc.levels.forEach(function (l) { by[l.ratio] = l.confluence.map(function (x) { return x.id; }); });
eq(by[0.618], ['E', 'S', 'H2'], '0.618: entry zone, stop (21.25 >= 21.2454) and the supply box touching the upper band edge (inclusive)');
eq(by[0.705], ['A1'], '0.705 (18.85 -> band 18.6615..19.0385): the Coinbase $35k sell zone');
eq(rc.levels.filter(function (l) { return l.ratio === 0.705; })[0].confluence[0].usd, 35000, 'sell item carries venue and $ figure');
eq(by[0.786], ['D1'], '0.786: demand box (16.0-16.5 vs band 16.2558..16.5842)');
eq(by[1.272], ['H1'], '1.272: supply box 48-49');
eq(by[1.618], ['T'], '1.618: target 58.6 within 1 %');
eq(by[0], [], 'a level with nothing nearby lists nothing');
eq(F.compute(fix(26), O, Object.assign({}, ctx, { stop: 21.24 })).levels[1].confluence.map(function (x) { return x.id; }), ['E', 'H2'], 'stop at 21.24 is outside the 1 % band');
/* inputs are read, never written */
var before = JSON.stringify(ctx); F.compute(fix(26), O, ctx); eq(JSON.stringify(ctx), before, 'context is not modified');
/* unavailable states */
eq(F.compute(fix(26).slice(0, 16), O, {}).reason, 'no confirmed impulse', 'confirmed low but no confirmed pivot high -> unavailable');
eq(F.compute(fix(26), { intervalSec: D, nowMs: (T(21) + D / 2) * 1000 }, {}).status, 'unavailable', 'forming candle 21 does not confirm the pivot high');
eq(F.compute(fix(26), { intervalSec: D, nowMs: (T(21) + D) * 1000 }, {}).status, 'ok', 'confirmed once candle 21 has closed');
var flat = []; for (var i = 0; i < 30; i++) flat.push({ time: T(i), open: 1, high: 2, low: 1, close: 1.5, volume: 1 });
eq(F.compute(flat, O, {}).reason, 'no confirmed impulse', 'flat series: no pivots -> unavailable');
eq(F.compute(fix(8), O, {}).reason, 'lookback', 'short series -> lookback');
/* a newer confirmed low with no confirmed high after it makes the leg unavailable (most recent low rule) */
var nl = fix(26).concat([]); for (i = 26; i < 40; i++) nl.push({ time: T(i), open: 25, high: 30, low: 22, close: 25, volume: 100 }); nl[30] = { time: T(30), open: 20, high: 29, low: 5, close: 20, volume: 100 };
eq(F.compute(nl, O, {}).status, 'unavailable', 'newer confirmed pivot low with no later confirmed high: unavailable, not the older leg');
/* determinism: appending later flat candles never changes the leg */
var l26 = F.compute(fix(26), O, {}).leg; for (var k = 22; k <= 40; k++) eq(F.compute(fix(k), O, {}).leg, l26, 'leg unchanged when ' + k + ' candles are available');
eq(JSON.stringify(F.compute(fix(30), O, ctx)), JSON.stringify(F.compute(fix(30), O, ctx)), 'deterministic');
ok(F.DEF.pivotLength === 5 && F.DEF.tie === 'strict' && F.DEF.tolerance === 0.01, 'definition constants');
console.log(n + ' checks' + (process.exitCode ? ' — FAILURES' : ', 0 failures'));
