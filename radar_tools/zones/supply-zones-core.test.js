/* supply-zones-core.test.js — node supply-zones-core.test.js
 * HAND-CHECKED FIXTURE (daily candles, i = 0..N-1, time = T0 + i*86400):
 *   i 0..11  : high 10, low 9, vol 100 (flat)
 *   i 12     : high 14, low 10, open 10, close 13.5 (GREEN), vol 500  -> the volume pivot (500 > the ten neighbours at 100)
 *   i 13..17 : high 12, low 9, vol 100  -> upper(17) = 12 < 14 so os = 0 (bearish) at the confirming candle 17
 *   i 18..21 : high 12, low 9, vol 100
 *   i 22     : high 14.5, low 9, vol 100 -> highest high of 18..22 = 14.5 > top 14 -> mitigated at candle 22
 *   Expected zone: top 14, bottom (14+10)/2 = 12, mid 13, originTime T(12), confirmedAt T(17)+86400 = T(18), mitigatedAt T(22)+86400 = T(23), volume 500, quoteEst 13.5*500 = 6750. */
var C = require('./supply-zones-core.js'), assert = require('assert'), n = 0;
function ok(c, m) { n++; if (!c) { console.error('FAIL: ' + m); process.exitCode = 1; } }
function eq(a, b, m) { n++; try { assert.deepStrictEqual(a, b); } catch (e) { console.error('FAIL: ' + m + '\n  got ' + JSON.stringify(a) + '\n  want ' + JSON.stringify(b)); process.exitCode = 1; } }
var T0 = 1700006400, D = 86400, T = function (i) { return T0 + i * D; };
function fix(N) {
  var cs = []; for (var i = 0; i < N; i++) cs.push({ time: T(i), open: 9.5, high: 10, low: 9, close: 9.6, volume: 100 });
  cs[12] = { time: T(12), open: 10, high: 14, low: 10, close: 13.5, volume: 500 };
  for (i = 13; i <= 21 && i < N; i++) cs[i] = { time: T(i), open: 9.5, high: 12, low: 9, close: 9.6, volume: 100 };
  if (N > 22) cs[22] = { time: T(22), open: 9.5, high: 14.5, low: 9, close: 9.8, volume: 100 };
  return cs;
}
var NOW = T(40) * 1000;   /* every fixture candle is closed */
var full = C.detectBearish(fix(30), { intervalSec: D, nowMs: NOW }), z = full.zones[0];
ok(full.available && full.zones.length === 1, 'one zone on the hand-checked fixture');
eq([z.top, z.bottom, z.mid], [14, 12, 13], 'geometry: top = H, bottom = (H+L)/2, midpoint');
eq([z.originTime, z.confirmedAt], [T(12), T(18)], 'origin and confirmation times are separate');
eq([z.mitigatedAt, z.mitigatedBy, z.rule], [T(23), T(22), 'wick'], 'mitigation recorded and the zone is retained');
eq([z.volume, z.quoteEst], [500, 6750], 'originating-candle volume and quote estimate');
ok(fix(30)[12].close > fix(30)[12].open, 'the pivot candle is green: a bearish zone on a green candle is allowed');
ok(full.detector.id === 'historical supply zones v1' && full.detector.pivotLength === 5 && full.detector.mitigation === 'wick' && /^[0-9a-f]{64}$/.test(full.detector.sourceSha256), 'detector provenance is carried in every result');
/* confirmation: absent before candle 17 has closed, present once it has */
eq(C.detectBearish(fix(30).slice(0, 17), { intervalSec: D, nowMs: NOW }).zones.length, 0, 'no zone with candles 0..16 (pivot needs candle 17)');
var a17 = C.detectBearish(fix(30).slice(0, 18), { intervalSec: D, nowMs: NOW }); eq(a17.zones.length, 1, 'zone exists once candle 17 has closed'); eq(a17.zones[0].confirmedAt, T(18), 'confirmedAt = close of candle 17');
/* forming candle: candle 17 not yet closed -> no zone; candle 22 forming -> no mitigation */
eq(C.detectBearish(fix(30), { intervalSec: D, nowMs: (T(17) + D / 2) * 1000 }).zones.length, 0, 'forming candle 17 does not confirm');
var f22 = C.detectBearish(fix(30), { intervalSec: D, nowMs: (T(22) + D / 2) * 1000 }); eq(f22.zones.length, 1, 'zone present'); eq(f22.zones[0].mitigatedAt, null, 'forming candle 22 does not mitigate');
eq(C.detectBearish(fix(30), { intervalSec: D, nowMs: (T(22) + D) * 1000 }).zones[0].mitigatedAt, T(23), 'mitigated once candle 22 has closed');
/* replay: appending future candles never changes earlier results */
for (var k = 18; k <= 30; k++) {
  var pre = C.detectBearish(fix(30).slice(0, k), { intervalSec: D, nowMs: NOW });
  pre.zones.forEach(function (p) { var f = full.zones.filter(function (q) { return q.id === p.id; })[0]; ok(!!f, 'prefix zone exists in the full result (' + k + ')'); var pm = p.mitigatedAt; eq([p.top, p.bottom, p.originTime, p.confirmedAt, p.volume], [f.top, f.bottom, f.originTime, f.confirmedAt, f.volume], 'prefix ' + k + ' fields identical'); ok(pm == null || pm === f.mitigatedAt, 'prefix ' + k + ': a recorded mitigation is never revised'); });
}
/* Close method: the wick above the top without a close above it does not mitigate */
eq(C.detectBearish(fix(30), { intervalSec: D, nowMs: NOW, mitigation: 'close' }).zones[0].mitigatedAt, null, "mitigation 'close': candle 22's wick alone does not remove the zone");
/* os = 1 (bullish state): the origin candle's low undercuts the later lows and its high does not exceed them -> no bearish zone */
var b = fix(30).map(function (c) { return Object.assign({}, c); }); b[12] = { time: T(12), open: 10, high: 10, low: 5, close: 9, volume: 500 }; for (var i2 = 13; i2 <= 17; i2++) b[i2] = Object.assign({}, b[i2], { high: 12, low: 9 });
eq(C.detectBearish(b, { intervalSec: D, nowMs: NOW }).zones.length, 0, 'a pivot candle that is a bullish-state candle (low below the later lows, high not above) makes no bearish zone');
/* tie: equal volume on a neighbour -> no pivot (strict) */
var tie = fix(30).map(function (c) { return Object.assign({}, c); }); tie[15].volume = 500; eq(C.detectBearish(tie, { intervalSec: D, nowMs: NOW }).zones.length, 0, 'volume tie with a neighbour yields no pivot (v1 strict rule)');
/* unavailable states */
eq(C.detectBearish(fix(30).slice(0, 10), { intervalSec: D, nowMs: NOW }).reason, 'lookback', 'fewer than 11 closed candles: unavailable (lookback)');
eq(C.detectBearish(fix(30).map(function (c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }), { intervalSec: D, nowMs: NOW }).reason, 'volume', 'no volume at all: unavailable, nothing substituted');
var hole = fix(30).map(function (c) { return Object.assign({}, c); }); hole[14].volume = null; eq(C.detectBearish(hole, { intervalSec: D, nowMs: NOW }).zones.length, 0, 'a pivot window touching a candle without volume cannot be a pivot');
/* same-candle creation and mitigation is retained (the script adds, then tests) */
var sm = []; for (i = 0; i < 20; i++) sm.push({ time: T(i), open: 1, high: 10, low: 9, close: 9.5, volume: 100 });
sm[3] = { time: T(3), open: 1, high: 10, low: 9, close: 9.5, volume: 100 };
/* os stays 0 from the series start; the origin candle (index 8) has high 10 == the later highs (not above), so os carries 0; then a later high of 11 inside t-4..t mitigates at creation */
sm[8] = { time: T(8), open: 1, high: 10, low: 9, close: 9.5, volume: 900 }; sm[13] = { time: T(13), open: 1, high: 11, low: 9, close: 9.5, volume: 100 };
var smr = C.detectBearish(sm, { intervalSec: D, nowMs: NOW }); ok(smr.zones.length === 1 && smr.zones[0].mitigatedAt === smr.zones[0].confirmedAt, 'a zone created and mitigated on the same candle is kept with mitigatedAt = confirmedAt');
/* selectDisplay */
function Z(id, bottom, top, o, mit) { return { id: id, originTime: o, bottom: bottom, top: top, mitigatedAt: mit || null }; }
var zs = [Z('d', 150, 160, 4), Z('a', 110, 120, 1), Z('b', 110, 125, 2), Z('c', 130, 140, 3), Z('e', 170, 180, 5), Z('m', 111, 112, 6, 99), Z('low', 50, 60, 7)];
var s = C.selectDisplay(zs, { E: 100, T: 175 });
eq([s.mode, s.total], ['path', 5], 'path mode: active zones intersecting E→T (the mitigated and the below-entry zones excluded); T=175 cuts the zone starting at 170? no: bottom 170 < 175 so it is in');
eq(s.shown.map(function (x) { return x.id; }), ['a', 'b', 'c'], 'three nearest by lower boundary, tie broken by originTime then id');
eq(s.all.map(function (x) { return x.id; }), ['a', 'b', 'c', 'd', 'e'], 'the expandable list is price-ordered and complete');
eq(C.selectDisplay(zs, { E: 100, T: 125 }).total, 2, 'a zone whose bottom is at/above T is not on the path'); /* a (110-120) and b (110-125); c bottom 130 >= 125 */
var cx = C.selectDisplay(zs, { ref: 105, vlo: 100, vhi: 145 }); eq([cx.mode, cx.shown.map(function (x) { return x.id; })], ['context', ['a', 'b', 'c']], 'no valid path: viewport context, zones above the latest close');
eq(C.selectDisplay(zs, {}).total, 0, 'no path and no viewport: nothing');
console.log(n + ' checks' + (process.exitCode ? ' — FAILURES' : ', 0 failures'));
