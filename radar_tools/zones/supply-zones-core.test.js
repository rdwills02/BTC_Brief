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
/* ===== item 52n — demand (bullish) blocks =====
 * HAND-CHECKED BULLISH FIXTURE: i 0..11 flat (high 10, low 9, vol 100); i 12: open 9, high 10, low 6, close 6.5, vol 500 (the volume pivot; low 6 < the lows of 13..17 -> os = 1 at candle 17);
 * i 13..21: high 12, low 9, vol 100; i 22: high 12, low 5.5 -> lowest low of 18..22 = 5.5 < bottom 6 -> mitigated at candle 22.
 * Expected: bottom = low 6, top = hl2 = (10+6)/2 = 8, mid 7, originTime T(12), confirmedAt T(18), mitigatedAt T(23), volume 500, quoteEst 6.5*500 = 3250. */
function bfix(N) {
  var cs = []; for (var i = 0; i < N; i++) cs.push({ time: T(i), open: 9.5, high: 10, low: 9, close: 9.6, volume: 100 });
  cs[12] = { time: T(12), open: 9, high: 10, low: 6, close: 6.5, volume: 500 };
  for (i = 13; i <= 21 && i < N; i++) cs[i] = { time: T(i), open: 9.5, high: 12, low: 9, close: 9.6, volume: 100 };
  if (N > 22) cs[22] = { time: T(22), open: 9.5, high: 12, low: 5.5, close: 9.8, volume: 100 };
  return cs;
}
var bf = C.detectBullish(bfix(30), { intervalSec: D, nowMs: NOW }), bz = bf.zones[0];
ok(bf.available && bf.zones.length === 1, 'bullish: one zone on the hand-checked fixture');
eq([bz.bottom, bz.top, bz.mid], [6, 8, 7], 'bullish geometry: bottom = L, top = (H+L)/2, midpoint');
eq([bz.originTime, bz.confirmedAt, bz.id], [T(12), T(18), 'hd1-' + T(12)], 'bullish: origin and confirmation separate; id prefix hd1');
eq([bz.mitigatedAt, bz.mitigatedBy, bz.rule], [T(23), T(22), 'wick'], 'bullish: mitigation at the declared candle, zone retained');
eq([bz.volume, bz.quoteEst], [500, 3250], 'bullish: candle volume and quote estimate');
eq(C.detectBearish(bfix(30), { intervalSec: D, nowMs: NOW }).zones.length, 0, 'the bullish fixture yields no bearish zone (os = 1 at the pivot)');
eq(C.detectBullish(fix(30), { intervalSec: D, nowMs: NOW }).zones.length, 0, 'the bearish fixture yields no bullish zone (os = 0)');
eq(C.detectBullish(bfix(30).slice(0, 17), { intervalSec: D, nowMs: NOW }).zones.length, 0, 'bullish: no zone with candles 0..16');
eq(C.detectBullish(bfix(30).slice(0, 18), { intervalSec: D, nowMs: NOW }).zones[0].confirmedAt, T(18), 'bullish: zone once candle 17 has closed');
eq(C.detectBullish(bfix(30), { intervalSec: D, nowMs: (T(17) + D / 2) * 1000 }).zones.length, 0, 'bullish: forming candle 17 does not confirm');
eq(C.detectBullish(bfix(30), { intervalSec: D, nowMs: (T(22) + D / 2) * 1000 }).zones[0].mitigatedAt, null, 'bullish: forming candle 22 does not mitigate');
for (k = 18; k <= 30; k++) {
  var bpre = C.detectBullish(bfix(30).slice(0, k), { intervalSec: D, nowMs: NOW });
  bpre.zones.forEach(function (p) { var f = bf.zones.filter(function (q) { return q.id === p.id; })[0]; ok(!!f, 'bullish prefix zone present (' + k + ')'); eq([p.top, p.bottom, p.originTime, p.confirmedAt, p.volume], [f.top, f.bottom, f.originTime, f.confirmedAt, f.volume], 'bullish prefix ' + k + ' identical'); ok(p.mitigatedAt == null || p.mitigatedAt === f.mitigatedAt, 'bullish prefix ' + k + ': mitigation never revised'); });
}
var bc = bfix(30); bc[22] = { time: T(22), open: 9.5, high: 12, low: 7, close: 5.8, volume: 100 };
eq([C.detectBullish(bc, { intervalSec: D, nowMs: NOW }).zones[0].mitigatedAt, C.detectBullish(bc, { intervalSec: D, nowMs: NOW, mitigation: 'close' }).zones[0].mitigatedAt], [null, T(23)], "bullish: 'wick' needs a low below the bottom, 'close' needs a close below it");
var bt = bfix(30); bt[8].volume = 500; eq(C.detectBullish(bt, { intervalSec: D, nowMs: NOW }).zones.length, 0, 'bullish: a tied volume neighbour yields no pivot (strict)');
eq(C.detectBullish(bfix(8), { intervalSec: D, nowMs: NOW }).reason, 'lookback', 'bullish: short series -> lookback');
eq(C.detectBullish(bfix(30).map(function (x) { return Object.assign({}, x, { volume: null }); }), { intervalSec: D, nowMs: NOW }).reason, 'volume', 'bullish: no volume -> unavailable (volume)');
/* bearish byte-identical to 52j: sha256 of the 52j module's output on the bearish fixture (+ selectDisplay) */
function old52j(r) { var o = Object.assign({}, r); delete o.unevaluable; delete o.partialVolume; delete o.partialRanges; if (o.detector) { o.detector = Object.assign({}, o.detector, { sourceSha256: '9563ced646fa13fed127c3e1f37a63e492251dd3ae64e13b4284d6c9792314dc' }); delete o.detector.sourceSha256Superseded; } return o; }   /* item 52p: the three added result fields are excluded; every 52j field is hashed as before. Item 52r: the detector pin is restored to the 52j value (9563ced6, now sourceSha256Superseded) so the golden hash is unchanged */
var h = require('crypto').createHash('sha256').update(JSON.stringify(old52j(C.detectBearish(fix(30), { intervalSec: D, nowMs: T(40) * 1000 }))) + JSON.stringify(C.selectDisplay(C.detectBearish(fix(30), { intervalSec: D, nowMs: T(40) * 1000 }).zones, { E: 5, T: 20 }))).digest('hex');
eq(h, 'e06ca536ca24f4be465280769020fab13c19c1673872c28631b55a5023f0abe9', 'bearish output byte-identical to 52j');
/* selectDemandDisplay */
function DZ(id, bottom, top, o, mit) { return { id: id, originTime: o, bottom: bottom, top: top, mitigatedAt: mit || null }; }
var dzs = [DZ('a', 90, 95, 1), DZ('b', 80, 85, 2), DZ('c', 70, 75, 3), DZ('d', 60, 65, 4), DZ('m', 88, 92, 5, 99), DZ('up', 110, 120, 6), DZ('far', 10, 20, 7)];
var ds = C.selectDemandDisplay(dzs, { S: 55, T: 130, ref: 100 });
eq([ds.mode, ds.total], ['path', 4], 'demand path: active zones intersecting [S,T] and below price; mitigated, above-price and below-S excluded');
eq(ds.shown.map(function (x) { return x.id; }), ['a', 'b', 'c'], 'three nearest below price by upper boundary, descending');
eq(ds.all.map(function (x) { return x.id; }), ['a', 'b', 'c', 'd'], 'expandable list complete');
var dx = C.selectDemandDisplay(dzs, { ref: 100, vlo: 65, vhi: 130 }); eq([dx.mode, dx.all.map(function (x) { return x.id; })], ['context', ['a', 'b', 'c', 'd']], 'demand context mode: viewport, below the latest close');
eq(C.selectDemandDisplay(dzs, {}).total, 0, 'demand: no path, no viewport -> nothing');
/* ---- item 52p (B4): incomplete volume ---- */
var base11 = fix(30).slice(0, 23);   /* complete-volume baseline: one supply zone */
eq(C.detectBearish(base11, { intervalSec: D, nowMs: NOW }).zones.length, 1, 'B4 baseline: complete volume -> one supply zone');
eq([C.detectBearish(base11, { intervalSec: D, nowMs: NOW }).partialVolume, C.detectBearish(base11, { intervalSec: D, nowMs: NOW }).unevaluable.length], [false, 0], 'B4: complete volume -> not partial');
/* Astra 11-candle case: pivot at index 5 of 11 (candles 0..10), one neighbour volume removed */
function eleven(side) { var cs = []; for (var i = 0; i < 11; i++) cs.push(side === 'bull' ? { time: T(i), open: 9.5, high: 10, low: 9, close: 9.6, volume: 100 } : { time: T(i), open: 9.5, high: 10, low: 9, close: 9.6, volume: 100 }); cs[5] = side === 'bull' ? { time: T(5), open: 10, high: 10, low: 6, close: 7, volume: 500 } : { time: T(5), open: 10, high: 14, low: 10, close: 13.5, volume: 500 }; return cs; }
var e11 = eleven('bear'), e11full = C.detectBearish(e11, { intervalSec: D, nowMs: NOW });
eq([e11full.available, e11full.zones.length, e11full.partialVolume], [true, 1, false], 'B4: 11-candle fixture, complete volume -> one supply zone');
var e11m = e11.map(function (x) { return Object.assign({}, x); }); e11m[8].volume = null;
var rm = C.detectBearish(e11m, { intervalSec: D, nowMs: NOW });
eq([rm.available, rm.reason, rm.zones.length, rm.partialVolume, rm.unevaluable.length], [true, null, 0, true, 1], 'B4: one neighbour volume removed -> pivot is UNEVALUABLE, not silently skipped');
eq([rm.unevaluable[0].originTime, rm.unevaluable[0].side, rm.unevaluable[0].windowFrom, rm.unevaluable[0].windowTo, rm.unevaluable[0].missingVolumeTimes], [T(5), 'supply', T(0), T(11), [T(8)]], 'B4: unevaluable entry carries the window and the missing time');
eq([rm.unevaluable[0].priceLow, rm.unevaluable[0].priceHigh], [e11[5].low, e11[5].high], 'B4: unevaluable entry carries the origin candle price range');
eq(rm.partialRanges, [{ from: T(0), to: T(11) }], 'B4: partial range reported');
/* zones that can be established are retained: the complete fixture plus a gap far from the zone */
var kept = fix(40).map(function (x) { return Object.assign({}, x); }); kept[30].volume = 500; kept[33].volume = null;
var kr = C.detectBearish(kept, { intervalSec: D, nowMs: NOW });
eq([kr.zones.length, kr.zones[0].id, kr.partialVolume, kr.unevaluable.map(function (u) { return u.originTime; })], [1, 'hs1-' + T(12), true, [T(30), T(33)]], 'B4: established zone retained; later gap reported as partial (pivot candidate 30 with a missing neighbour is not ruled out)');
/* a missing neighbour that is ruled out by a finite larger neighbour is not unevaluable */
var ro = fix(30).map(function (x) { return Object.assign({}, x); }); ro[5].volume = null; ro[3].volume = 100;   /* index 8 (window 3..13) is not a pivot anyway: volume 100 vs 100 tie */
var rr1 = C.detectBearish(ro, { intervalSec: D, nowMs: NOW });
ok(rr1.unevaluable.every(function (u) { return u.missingVolumeTimes.length > 0; }), 'B4: every unevaluable entry names at least one missing time');
eq(C.detectBearish(fix(30).map(function (x) { return Object.assign({}, x, { volume: null }); }), { intervalSec: D, nowMs: NOW }).reason, 'volume', 'B4: no volume at all stays unavailable (volume)');
eq(C.detectBearish(fix(30), { intervalSec: D, nowMs: NOW }).unevaluable, [], 'B4: complete series -> empty unevaluable');
/* bullish mirror */
var b11 = eleven('bull'), b11full = C.detectBullish(b11, { intervalSec: D, nowMs: NOW });
var os1 = b11full.zones.length;   /* bullish needs os = 1 at confirmation; the low-wick candle sets it */
eq([b11full.available, os1, b11full.partialVolume], [true, 1, false], 'B4 bullish: 11-candle fixture, complete volume -> one demand zone');
var b11m = b11.map(function (x) { return Object.assign({}, x); }); b11m[8].volume = null;
var bm = C.detectBullish(b11m, { intervalSec: D, nowMs: NOW });
eq([bm.available, bm.reason, bm.zones.length, bm.partialVolume, bm.unevaluable.length, bm.unevaluable[0] && bm.unevaluable[0].side], [true, null, 0, true, 1, 'demand'], 'B4 bullish: one neighbour volume removed -> unevaluable (demand)');
eq(bm.partialRanges, [{ from: T(0), to: T(11) }], 'B4 bullish: partial range reported');
/* the bearish detector does not report the demand-side pivot and vice versa */
eq([C.detectBearish(b11m, { intervalSec: D, nowMs: NOW }).unevaluable.length, C.detectBullish(e11m, { intervalSec: D, nowMs: NOW }).unevaluable.length], [0, 0], 'B4: unevaluable follows the regime side (os)');
/* replay record */
var rc = C.replayRecord(fix(30).concat([{ time: T(30), open: 9, high: 10, low: 9, close: 9.5, volume: 1 }, { time: T(12), open: 1, high: 1, low: 1, close: 1, volume: 1 }]).filter(function (x) { return x.time !== T(20); }), full, { source: 'kraken', pair: 'ETH/USD', intervalSec: D, rawInputSha256: 'ab'.repeat(32), asOfMs: T(30) * 1000 });
eq([rc.source, rc.pair, rc.intervalSec, rc.firstInputTime, rc.rawInputSha256, rc.asOfMs], ['kraken', 'ETH/USD', D, T(0), 'ab'.repeat(32), T(30) * 1000], 'replay record: source, pair, interval, first input, raw hash, as-of');
eq([rc.missingBarTimes, rc.lastClosedTime, rc.formingBarExclusion.indexOf('1 excluded') > 0, /1 dropped/.test(rc.missingDuplicatePolicy)], [[T(20)], T(29), true, true], 'replay record: missing bar explicit, forming bar excluded, duplicate dropped');
eq([rc.detector.sourceSha256, rc.detector.pivotLength, rc.zones[0].id, rc.zones[0].confirmedAt, rc.zones[0].mitigatedAt], [C.DETECTOR.sourceSha256, 5, 'hs1-' + T(12), T(18), T(23)], 'replay record: detector hash/settings and zone times');
console.log(n + ' checks' + (process.exitCode ? ' — FAILURES' : ', 0 failures'));
