'use strict';
// item 52e B6: sellzone-core acceptance. Pure functions only; books are built with book-core.js on declared synthetic ladders (the Astra fixtures are anchor 100 / finite edge 120).
const B = require('./book-core.js'), S = require('./sellzone-core.js');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL ' + name + ': ' + e.message); } }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion'); }
function near(a, b, e, m) { if (!(Math.abs(a - b) <= (e || 1e-9))) throw new Error((m || '') + ' got ' + a + ' want ' + b); }
const H = Date.UTC(2026, 9, 14, 12, 0, 0), HR = 3600000, ASOF = H + 600000;
const ctx = (over) => Object.assign({ pair: 'X/USD', count: 500, requestStartUtc: '2026-10-14T12:10:00.000Z', receivedAtUtc: '2026-10-14T12:10:00.300Z' }, over || {});
const r6 = x => Number(x.toFixed(6));
const ladder = (start, step, n, size) => { const a = []; for (let i = 0; i < n; i++) a.push([r6(start + step * i), size]); return a; };
const upTo = (max) => ladder(100.1, 0.1, Math.round((max - 100.1) / 0.1) + 1, 1);   // uniform ordinary depth 100.1 .. max
const bidsOrd = ladder(99.9, -0.1, 150, 1);
const G = (v, anchor) => B.makeGrid(anchor || 100, 0.01, '2026-10', 'coinbase', 'X/USD', v || 3);
function cb(asks, bids, g) { const raw = { bids: (bids || bidsOrd).map(x => [String(x[0]), String(x[1]), 1]), asks: asks.map(x => [String(x[0]), String(x[1]), 1]), sequence: 7, time: '2026-10-14T12:10:00.100Z' }; return B.buildRecord(B.parseCoinbase(raw, ctx()), g || G()); }
function kr(asks, bids, g, count) { const raw = { bids: (bids || bidsOrd).map(x => [String(x[0]), String(x[1]), 1760000000]), asks: asks.map(x => [String(x[0]), String(x[1]), 1760000000]) }; return B.buildRecord(B.parseKraken(raw, ctx({ count: count || 500 })), g || B.makeGrid(100, 0.01, '2026-10', 'kraken', 'X/USD', 3)); }
const P = S.calibrationCandidates.clustering[0], CUT = { concentration: 2, material: 1, asOfMs: ASOF, maxAgeMs: 1800000 };
// activity baseline fixtures
function krakenRows(n, vwap, vol, skip) { const rows = []; for (let k = 0; k < n; k++) { const ts = H - 168 * HR + k * HR; if (skip && skip(k)) continue; rows.push([ts / 1000, vwap, vwap, vwap, vwap, vwap, vol, 10]); } return rows; }
function cbRows(n, low, high, close, vol) { const rows = []; for (let k = 0; k < n; k++) rows.push([(H - 168 * HR + k * HR) / 1000, low, high, close, close, vol]); return rows; }
const baseK = (q) => S.activityBaseline(krakenRows(168, q, 1000), 'kraken', H);   // quote/hour = q x 1000
const wallAt = (price, size, ladderMax) => cb(upTo(ladderMax || 140).concat([[price, size]]));

// ---- B1 coverage in absolute prices (Astra fixtures) ----
t('Astra fixture 1 (anchor 100, edge 120): E 80 / T 110 is 37.5 % above entry yet INSIDE the finite grid -> complete', () => {
  const r = cb(upTo(119), null, G(2)), c = S.coverage(r, G(2), 80, 110); eq(c.status, 'complete'); eq(c.gridCoveredTo, 120); eq(c.coveredTo, 120); eq(c.pathLo, 80); eq(c.pathHi, 110); eq(c.bookComplete, true);
});
t('Astra fixture 2 (anchor 100, edge 120): E 115 / T 125 is only 8.7 % above entry yet in the unresolved TAIL -> gridLimited with tail mass; v3 resolves it', () => {
  const r2 = cb(upTo(130), null, G(2)), c2 = S.coverage(r2, G(2), 115, 125); eq(c2.status, 'gridLimited'); eq(c2.coveredTo, 120); ok(c2.tailMassBeyondGrid > 0, 'tail mass reported');
  const r3 = cb(upTo(130), null, G(3)), c3 = S.coverage(r3, G(3), 115, 125); eq(c3.status, 'complete'); eq(c3.gridCoveredTo, 140);
});
t('source-limited (Kraken cap) and both-limited are separated from grid limits, in absolute prices', () => {
  const asks = ladder(100.1, 0.1, 50, 1), r = kr(asks, null, null, 50), farthest = asks[49][0];   // cap reached, farthest ask 105
  const c = S.coverage(r, B.makeGrid(100, 0.01, '2026-10', 'kraken', 'X/USD', 3), 100, 110); eq(c.status, 'sourceLimited'); eq(c.bookCoveredTo, farthest); eq(c.coveredTo, farthest); eq(c.capReached, true);
  const g2 = B.makeGrid(100, 0.01, '2026-10', 'kraken', 'X/USD', 2), r2 = kr(asks, null, g2, 50), cb2 = S.coverage(r2, g2, 100, 125); eq(cb2.status, 'both'); eq(cb2.coveredTo, farthest);
  eq(S.coverage(r, B.makeGrid(100, 0.01, '2026-10', 'kraken', 'X/USD', 3), 100, 104).status, 'complete');
});
t('coverage rejects a grid that is not the record\'s grid (no silent rebuild on other rules)', () => {
  const r = cb(upTo(130), null, G(3)); let threw = false; try { S.coverage(r, G(2), 100, 110); } catch (e) { threw = /grid-mismatch/.test(e.message); } ok(threw);
  eq(S.coverage(r, r.grid, 100, 110).status, 'complete', 'accepts the grid id string');
});
t('E or T exactly on a computed grid edge is not off by one ulp (anchor x (1 + bp/10000) float edges)', () => {
  [[2, 120], [3, 140], [3, 110], [3, 100.5]].forEach(([v, px]) => { const g = G(v), r = cb(upTo(Math.min(px, 118)), null, g); eq(S.coverage(r, g, 100, px).status, 'complete', 'v' + v + ' T=' + px); });
  [3.1178, 2505.27, 0.681].forEach(an => { const g = B.makeGrid(an, 0.0001, 'P', 'coinbase', 'X/USD', 3), top = an * 1.4, r = cb([[an * 1.01, 1]], [[an * 0.99, 1]], g); eq(S.coverage(r, g, an, top).status, 'complete', 'anchor ' + an); });
});
// ---- B2 / B3 candidate zones ----
t('equal ordinary depth -> zero candidate zones; with an adequate baseline the all-clear state is issued', () => {
  const r = cb(upTo(140)), z = S.candidateZones(r, G(), 100, 130, P); eq(z.zones.length, 0); eq(z.unassessed.length, 0);
  const o = S.sellObstacleZones(r, G(), 100, 130, baseK(100), P, CUT); eq(o.zones.length, 0); eq(o.states.map(s => s.code), ['noSubstantialZone']); eq(o.states[0].text, 'No substantial sell zone meets the criteria between entry and target.');
});
t('one large fresh concentration forms a zone, Q exact, C high, no persistence input needed', () => {
  const r = wallAt(105.1, 500), z = S.candidateZones(r, G(), 100, 130, P); eq(z.zones.length, 1); const zz = z.zones[0]; eq(zz.lo, 105); eq(zz.hi, 105.5); ok(zz.Q >= 105.1 * 500 && zz.Q < 105.1 * 500 + 700, 'Q = wall + the few ordinary levels in the bin: ' + zz.Q);
  ok(zz.C > 10, 'C ' + zz.C); eq(zz.approx, { E: false, T: false }); eq(zz.Qlo, zz.Qhi);
});
t('adjacent large bins merge into one correctly valued zone (gap bins inside the range are counted); a material gap keeps zones separate', () => {
  const r = cb(upTo(140).concat([[105.1, 500], [106.1, 500]])), z = S.candidateZones(r, G(), 100, 130, P); eq(z.zones.length, 1); const zz = z.zones[0]; eq(zz.lo, 105); eq(zz.hi, 106.5);
  const map = {}; r.bins.a.forEach(x => map[x[0]] = x[2]); let sum = 0; zz.bins.forEach(b => { sum += map[b.idx]; }); near(zz.Q, sum, 1e-6); eq(zz.bins.map(b => b.member).includes(false), true, 'a low-density gap bin sits inside the zone');
  const r2 = cb(upTo(140).concat([[105.1, 500], [107.1, 500]])), z2 = S.candidateZones(r2, G(), 100, 130, P); eq(z2.zones.length, 2); eq(z2.zones.map(q => [q.lo, q.hi]), [[105, 105.5], [107, 107.5]]);
  const r3 = cb(upTo(140).concat([[105.1, 500], [105.6, 500]])), z3 = S.candidateZones(r3, G(), 100, 130, P); eq(z3.zones.length, 1); eq([z3.zones[0].lo, z3.zones[0].hi], [105, 106]);
});
t('a zone above T is excluded; a zone between +10 % and T is eligible when covered', () => {
  eq(S.candidateZones(wallAt(135.1, 500), G(), 100, 130, P).zones.length, 0, 'above T');
  const z = S.candidateZones(wallAt(115.1, 500), G(), 100, 130, P); eq(z.zones.length, 1); ok(z.zones[0].pctAboveEntry.lo > 14.9 && z.zones[0].pctAboveEntry.reference === 'E');
});
t('boundary bin at T yields bounds not a point: Qlo 0, Qhi full bin, Q null, approx.T', () => {
  const r = wallAt(110.2, 500), z = S.candidateZones(r, G(), 100, 110.5, P); eq(z.zones.length, 1); const zz = z.zones[0]; eq(zz.approx, { E: false, T: true }); eq(zz.Q, null); eq(zz.Qlo, 0); ok(zz.Qhi > 110.2 * 500);
  eq(zz.bins[0].boundary, 'T');
});
t('boundary bin at E yields bounds too; an interior zone beside it keeps an exact Q', () => {
  const r = cb(upTo(140).concat([[100.3, 500], [105.1, 500]])), z = S.candidateZones(r, G(), 100.3, 130, P); const e = z.zones.filter(q => q.approx.E)[0], i = z.zones.filter(q => !q.approx.E)[0]; ok(e && i); eq(e.Q, null); eq(e.Qlo, 0); ok(i.Q > 0 && i.Qlo === i.Qhi);
});
t('zone width is capped at maxZoneWidth (price units from percent of E): contiguous heavy bins split rather than merge past the cap', () => {
  const walls = []; for (let p = 105.1; p < 112; p += 1) walls.push([r6(p), 500]); const r = cb(upTo(140).concat(walls)), z = S.candidateZones(r, G(), 100, 130, Object.assign({}, P, { maxZoneWidthPct: 3 }));
  ok(z.zones.length >= 2, 'split ' + z.zones.length); z.zones.forEach(q => ok(q.widthPrice <= 3 + 1e-6, 'width ' + q.widthPrice));
  eq(S.resolveParams(P, 100).maxZoneWidthPrice, 5); eq(S.resolveParams({ baselineMethod: 'median', neighborhoodPrice: 4, seedMinConcentration: 3, extendMinConcentration: 1.5, maxGapPrice: 1, maxZoneWidthPrice: 5 }, 100).neighborhoodPrice, 4);
});
t('C needs a covered neighborhood: Kraken-capped book -> zone near the covered edge is unassessed, never given a C from partial data', () => {
  const asks = upTo(110).concat([[108.1, 500]]).sort((a, b) => a[0] - b[0]), r = kr(asks, null, null, asks.length), g = B.makeGrid(100, 0.01, '2026-10', 'kraken', 'X/USD', 3), z = S.candidateZones(r, g, 100, 130, P);
  eq(z.coverage.status, 'sourceLimited'); eq(z.zones.length, 0); ok(z.unassessed.some(u => /not-covered|beyond/.test(u.reason)), 'unassessed recorded');
  const o = S.sellObstacleZones(r, g, 100, 130, baseK(100), P, CUT); ok(!o.states.some(s => s.code === 'noSubstantialZone'), 'no all-clear'); ok(o.states.some(s => s.code === 'depthIncomplete' && s.detail.coveredTo === 110));
});
// ---- B4 activity baseline ----
t('turnover counterexample: 99@100 + 1@200 -> Kraken VWAP x volume = 10,100; Coinbase close x volume = 20,000 (estimate) with low/high bounds', () => {
  const k = S.activityBaseline(krakenRows(168, 101, 100), 'kraken', H), c = S.activityBaseline(cbRows(168, 100, 200, 200, 100), 'coinbase', H);
  eq(k.median, 10100); eq(k.medianLo, 10100); eq(k.medianHi, 10100); eq(k.exact, true); eq(k.label, 'quote turnover'); eq(c.median, 20000); eq(c.medianLo, 10000); eq(c.medianHi, 20000); eq(c.exact, false); eq(c.label, 'estimate'); ok(/ESTIMATE/.test(c.method));
});
t('119 valid hours of 168 -> unavailable; 120 -> provisional with the count; 168 -> complete', () => {
  const b119 = S.activityBaseline(krakenRows(119, 100, 10), 'kraken', H), b120 = S.activityBaseline(krakenRows(120, 100, 10), 'kraken', H), b168 = S.activityBaseline(krakenRows(168, 100, 10), 'kraken', H);
  eq(b119.status, 'unavailable'); eq(b119.median, null); eq(b119.validHours, 119); eq(b120.status, 'provisional'); eq(b120.validHours, 120); ok(/120\/168/.test(b120.reason)); eq(b120.median, 1000); eq(b168.status, 'complete'); eq(b168.missingHours.length, 0);
  eq(b120.missingHours.length, 48);
});
t('the running hour is excluded; rows outside [H-168h, H) and unaligned rows are clipped; duplicates are deduplicated', () => {
  const rows = krakenRows(168, 100, 10); rows.push([H / 1000, 100, 100, 100, 100, 100, 1e9, 1], [(H - 169 * HR) / 1000, 100, 100, 100, 100, 100, 1e9, 1], [(H - 3 * HR + 1800000) / 1000, 100, 100, 100, 100, 100, 1e9, 1], rows[5].slice());
  const b = S.activityBaseline(rows, 'kraken', H); eq(b.validHours, 168); eq(b.median, 1000); eq(b.clippedOutside, 3); eq(b.dupConflicts, 0); eq(b.window.endMs, H);
  const rows2 = krakenRows(168, 100, 10); rows2.push([rows2[5][0], 100, 100, 100, 100, 999, 10, 1]); eq(S.activityBaseline(rows2, 'kraken', H).dupConflicts, 1);
});
t('zero-volume hours that were observed are kept; absent buckets stay missing (never inferred zero); a zero median is unavailable', () => {
  const rows = krakenRows(168, 100, 10); for (let i = 0; i < 20; i++) rows[i] = [rows[i][0], 100, 100, 100, 100, 100, 0, 0];
  const a = S.activityBaseline(rows, 'kraken', H); eq(a.validHours, 168); eq(a.median, 1000, '20 observed zeros do not move the median'); eq(a.hourly.filter(h => h[1] === 0).length, 20);
  const miss = S.activityBaseline(krakenRows(168, 100, 10, k => k < 10), 'kraken', H); eq(miss.validHours, 158); eq(miss.missingHours.length, 10); eq(miss.missingHours[0], H - 168 * HR); eq(miss.median, 1000, 'missing buckets are not zeros');
  const z = krakenRows(168, 100, 10); for (let i = 0; i < 90; i++) z[i] = [z[i][0], 100, 100, 100, 100, 100, 0, 0]; const zb = S.activityBaseline(z, 'kraken', H); eq(zb.status, 'unavailable'); eq(zb.reason, 'zero median'); eq(zb.median, null);
});
t('H must be a UTC hour start; unknown venue throws; Coinbase malformed rows are counted, not used', () => {
  let n = 0; try { S.activityBaseline([], 'kraken', H + 1); } catch (e) { n++; } try { S.activityBaseline([], 'binance', H); } catch (e) { n++; } eq(n, 2);
  const rows = cbRows(168, 99, 101, 100, 5); rows[3] = [rows[3][0], 'x', 'y', 'z', 'q', 'v']; const b = S.activityBaseline(rows, 'coinbase', H); eq(b.malformed, 1); eq(b.validHours, 167);
});
// ---- B3 M / materiality, B5 states ----
t('M bounds straddling the cutoff -> uncertain (Coinbase estimate); Kraken exact baseline decides pass/fail', () => {
  const r = wallAt(105.1, 500), cbBase = S.activityBaseline(cbRows(168, 100, 200, 200, 100), 'coinbase', H);   // median 20000, lo 10000 hi 20000
  const q = S.candidateZones(r, G(), 100, 130, P).zones[0].Q, cut = { concentration: 2, material: q / 15000 };   // Mlo = Q/20000, Mhi = Q/10000 -> cutoff between
  const o = S.sellObstacleZones(r, G(), 100, 130, cbBase, P, cut), z = o.zones[0]; near(z.Mlo, q / 20000, 1e-9); near(z.Mhi, q / 10000, 1e-9); near(z.M, q / 20000, 1e-9); eq(z.materiality, 'uncertain'); eq(z.verdict, 'uncertain'); eq(o.qualifying, []);
  eq(S.sellObstacleZones(r, G(), 100, 130, cbBase, P, { concentration: 2, material: q / 20000 }).zones[0].materiality, 'pass');
  eq(S.sellObstacleZones(r, G(), 100, 130, cbBase, P, { concentration: 2, material: q / 9000 }).zones[0].materiality, 'fail');
  const kb = S.activityBaseline(krakenRows(168, 100, 100), 'kraken', H);   // 10,000 exact
  eq(S.sellObstacleZones(r, G(), 100, 130, kb, P, { concentration: 2, material: q / 10000 + 1e-6 }).zones[0].materiality, 'fail'); eq(S.sellObstacleZones(r, G(), 100, 130, kb, P, { concentration: 2, material: q / 10000 - 1e-6 }).zones[0].materiality, 'pass');
});
t('approx boundary zone: M bounds come from Qlo..Qhi, M is null, materiality uncertain when the cutoff sits inside the range', () => {
  const r = wallAt(110.2, 500), kb = S.activityBaseline(krakenRows(168, 100, 100), 'kraken', H), z0 = S.candidateZones(r, G(), 100, 110.5, P).zones[0];
  const o = S.sellObstacleZones(r, G(), 100, 110.5, kb, P, { concentration: 2, material: z0.Qhi / 10000 / 2 }), z = o.zones[0]; eq(z.M, null); eq(z.Mlo, 0); near(z.Mhi, z0.Qhi / 10000, 1e-9); eq(z.materiality, 'uncertain');
});
t('a small notional that dominates a thin book fails the material-size test; a large one passes (same concentration)', () => {
  const small = cb(upTo(140).concat([[105.1, 8]])), big = cb(upTo(140).concat([[105.1, 5000]])), kb = S.activityBaseline(krakenRows(168, 100, 1000), 'kraken', H), cut = { concentration: 2, material: 1 };   // 100,000 quote / hour
  const zs = S.sellObstacleZones(small, G(), 100, 130, kb, { baselineMethod: 'median', neighborhoodPct: 4, seedMinConcentration: 2, extendMinConcentration: 1.2, maxGapPct: 1, maxZoneWidthPct: 5 }, cut).zones, zb = S.sellObstacleZones(big, G(), 100, 130, kb, P, cut);
  ok(zs.length === 0 || zs[0].materiality === 'fail', 'small does not pass'); eq(zb.zones[0].materiality, 'pass'); eq(zb.zones[0].verdict, 'pass'); eq(zb.qualifying.length, 1);
});
t('states: baseline unavailable -> materiality not assessed (zones still listed, no pass, no all-clear)', () => {
  const r = wallAt(105.1, 500), bu = S.activityBaseline(krakenRows(100, 100, 10), 'kraken', H), o = S.sellObstacleZones(r, G(), 100, 130, bu, P, CUT);
  eq(o.states.map(s => s.code), ['baselineUnavailable']); eq(o.states[0].text, 'Materiality not assessed: trading-activity baseline unavailable.'); eq(o.zones[0].materiality, 'unavailable'); eq(o.zones[0].verdict, 'unavailable'); eq(o.qualifying, []);
  eq(S.sellObstacleZones(cb(upTo(140)), G(), 100, 130, null, P, CUT).states.map(s => s.code), ['baselineUnavailable']);
});
t('states: depth incomplete shows the covered price; stale observation; invalid path; no continuous depth', () => {
  const r2 = cb(upTo(130), null, G(2)), o = S.sellObstacleZones(r2, G(2), 115, 125, baseK(100), P, CUT); const inc = o.states.filter(s => s.code === 'depthIncomplete')[0]; ok(inc, 'incomplete state'); eq(inc.text, 'Depth incomplete before target.'); eq(inc.detail.coveredTo, 120); eq(inc.detail.target, 125); ok(o.totalAskMassOnPath.lowerBound);
  const st = S.sellObstacleZones(cb(upTo(140)), G(), 100, 130, baseK(100), P, Object.assign({}, CUT, { asOfMs: ASOF + 3 * HR })); ok(st.states.some(s => s.code === 'stale' && s.text === 'Depth observation is stale.')); ok(!st.states.some(s => s.code === 'noSubstantialZone'));
  eq(S.sellObstacleZones(cb(upTo(140)), G(), 130, 100, baseK(100), P, CUT).states[0].code, 'pathInvalid'); eq(S.sellObstacleZones({ empty: true, grid: G().version && B.gridId(G()) }, G(), 100, 130, baseK(100), P, CUT).states[0].code, 'depthIncomplete');
});
t('total observed ask mass E->T is reported separately, with bounds at boundary bins', () => {
  const r = cb(upTo(140)), o = S.sellObstacleZones(r, G(), 100.3, 110.5, baseK(100), P, CUT); ok(o.totalAskMassOnPath.Qhi > o.totalAskMassOnPath.Qlo && o.totalAskMassOnPath.Qlo > 0); eq(o.totalAskMassOnPath.lowerBound, false);
  const full = S.sellObstacleZones(r, G(), 100.5, 110, baseK(100), P, CUT).totalAskMassOnPath; const gg = G(), ti = gg.edges.findIndex(x => Math.abs(x - 110) < 1e-6) + 1, tbin = r.bins.a.filter(x => x[0] === ti)[0]; ok(tbin && tbin[2] > 0); near(full.Qhi - full.Qlo, tbin[2], 1e-6, 'item 52p B2: even a bin-aligned T has an upper bound - the bin that begins at T is unknown allocation (an ask exactly at T lies in it)');
});
t('a fully observed path with a non-qualifying zone still gives the all-clear only when no zone is pass/uncertain/unavailable', () => {
  const r = wallAt(105.1, 5), o = S.sellObstacleZones(r, G(), 100, 130, baseK(100), Object.assign({}, P, { seedMinConcentration: 1.4, extendMinConcentration: 1.1 }), { concentration: 50, material: 1 });
  ok(o.zones.length >= 1 && o.zones.every(z => z.verdict === 'fail')); eq(o.states.map(s => s.code), ['noSubstantialZone']);
});
t('determinism: identical inputs -> byte-identical output; inputs are not mutated', () => {
  const r = cb(upTo(140).concat([[105.1, 500], [107.1, 900]])), snap = JSON.stringify(r), b = baseK(100), a1 = JSON.stringify(S.sellObstacleZones(r, G(), 100, 130, b, P, CUT)), a2 = JSON.stringify(S.sellObstacleZones(JSON.parse(snap), G(), 100, 130, JSON.parse(JSON.stringify(b)), P, CUT)); eq(a1, a2); eq(JSON.stringify(r), snap);
  eq(JSON.stringify(S.activityBaseline(krakenRows(168, 100, 10), 'kraken', H)), JSON.stringify(S.activityBaseline(krakenRows(168, 100, 10), 'kraken', H)));
});
t('both grid versions: same raw book gives the same zone list inside +20 % (v2 vs v3), and v3 can place a zone the v2 tail could not', () => {
  const asks = upTo(125).concat([[105.1, 500]]), r2 = cb(asks, null, G(2)), r3 = cb(asks, null, G(3)), z2 = S.candidateZones(r2, G(2), 100, 118, P), z3 = S.candidateZones(r3, G(3), 100, 118, P);
  eq(z2.zones.map(z => [z.lo, z.hi, z.Q]), z3.zones.map(z => [z.lo, z.hi, z.Q]));
  const w = cb(upTo(135).concat([[125.1, 500]]), null, G(3)); eq(S.candidateZones(w, G(3), 100, 130, P).zones.length, 1); eq(S.candidateZones(cb(upTo(135).concat([[125.1, 500]]), null, G(2)), G(2), 100, 130, P).zones.length, 0, 'v2 cannot see beyond +20 %');
});
t('param validation: missing cutoffs/params throw; calibrationCandidates is labelled as non-recommending', () => {
  let n = 0; try { S.candidateZones(cb(upTo(140)), G(), 100, 130, { seedMinConcentration: 3 }); } catch (e) { n++; } try { S.candidateZones(cb(upTo(140)), G(), 100, 130, Object.assign({}, P, { extendMinConcentration: 9 })); } catch (e) { n++; } eq(n, 2);
  ok(/no recommendation/.test(S.calibrationCandidates.label)); eq(S.calibrationCandidates.clustering.length, 4);
  eq(S.sellObstacleZones(wallAt(105.1, 500), G(), 100, 130, baseK(100), P, {}).zones[0].verdict, null, 'no cutoffs supplied -> no verdict');
});
t('stale = staleMultiplier x effective scheduled cadence (cadence.json, effective-dated): hourly 34 min fresh / 95 min stale; q15 25 min stale', () => {
  const rec = cb(upTo(140)), recvMs = Date.parse(rec.recv), bk = baseK(100), HOURLY = [{ venue: 'coinbase', pair: 'X/USD', tier: 'h1', cadenceMs: 3600000, fromMs: 0, toMs: null }], Q15T = [{ venue: 'coinbase', pair: 'X/USD', tier: 'q15', cadenceMs: 900000, fromMs: 0, toMs: null }];
  const run = (table, ageMin, mult) => { const f = S.staleMaxAgeMs(table, 'coinbase', 'X/USD', recvMs + ageMin * 60000, mult == null ? 1.5 : mult); return { f, o: S.sellObstacleZones(rec, G(), 100, 130, bk, P, { concentration: 2, material: 1, asOfMs: recvMs + ageMin * 60000, maxAgeMs: f.maxAgeMs }) }; };
  let r = run(HOURLY, 34); eq(r.f.maxAgeMs, 5400000); eq(r.f.cadenceMs, 3600000); ok(!r.o.states.some(s => s.code === 'stale'), '34 min hourly not stale'); eq(r.o.states.map(s => s.code), ['noSubstantialZone']);
  r = run(HOURLY, 95); ok(r.o.states.some(s => s.code === 'stale'), '95 min hourly stale'); ok(!r.o.states.some(s => s.code === 'noSubstantialZone'));
  r = run(HOURLY, 90); ok(!r.o.states.some(s => s.code === 'stale'), 'exactly 1.5 x cadence is not stale (strictly greater)');
  r = run(Q15T, 25); eq(r.f.maxAgeMs, 1350000); ok(r.o.states.some(s => s.code === 'stale'), '25 min q15 stale'); r = run(Q15T, 20); ok(!r.o.states.some(s => s.code === 'stale'), '20 min q15 fresh');
  eq(run(HOURLY, 34, 1).f.maxAgeMs, 3600000, 'multiplier is a parameter');
});
t('cadence is effective-dated: the entry in force at the judged time decides; no entry -> freshness unknown, no all-clear; bad multiplier throws', () => {
  const T0 = Date.UTC(2026, 9, 14, 12, 0, 0), tbl = [{ venue: 'coinbase', pair: 'X/USD', tier: 'h1', cadenceMs: 3600000, fromMs: 0, toMs: T0 }, { venue: 'coinbase', pair: 'X/USD', tier: 'q15', cadenceMs: 900000, fromMs: T0, toMs: null }, { venue: 'kraken', pair: 'X/USD', tier: 'h1', cadenceMs: 3600000, fromMs: 0, toMs: null }];
  eq(S.staleMaxAgeMs(tbl, 'coinbase', 'X/USD', T0 - 1, 1.5).tier, 'h1'); eq(S.staleMaxAgeMs(tbl, 'coinbase', 'X/USD', T0, 1.5).tier, 'q15'); eq(S.staleMaxAgeMs(tbl, 'coinbase', 'X/USD', T0, 1.5).maxAgeMs, 1350000);
  eq(S.staleMaxAgeMs(tbl, 'kraken', 'ETH/USD', T0, 1.5).maxAgeMs, null); eq(S.staleMaxAgeMs([], 'kraken', 'X/USD', T0, 1.5).maxAgeMs, null);
  const rec = cb(upTo(140)), o = S.sellObstacleZones(rec, G(), 100, 130, baseK(100), P, { concentration: 2, material: 1, asOfMs: Date.parse(rec.recv) + 60000, maxAgeMs: null }); eq(o.states.map(s => s.code), ['freshnessUnknown']);
  let n = 0; try { S.staleMaxAgeMs(tbl, 'kraken', 'X/USD', T0, 0); } catch (e) { n++; } try { S.staleMaxAgeMs(tbl, 'kraken', 'X/USD', T0, 'x'); } catch (e) { n++; } eq(n, 2);
  eq(S.calibrationCandidates.staleMultiplier, 1.5); ok(S.calibrationCandidates.maxAgeMs === undefined, 'fixed 30 min limit is gone');
});

// ---- item 52p B2: boundary uncertainty (Astra Outstanding Package Implementation Review 2026-10-15, B2) ----
t('B2 fixture 1: E 120 / T 121 with a 100,000-quote ask exactly at 121 -> the T bin is unknown allocation: not "1 unit on path", never an all-clear', () => {
  const g = G(3), r = cb(upTo(140).concat([[121, 100000 / 121]]), null, g), base = S.activityBaseline(krakenRows(168, 1, 1), 'kraken', H), res = S.sellObstacleZones(r, g, 120, 121, base, P, CUT), tb = r.bins.a.filter(x => x[0] === B.binIndex(g, 121))[0];
  ok(tb && tb[2] > 99999, 'the big ask sits in the bin that begins at T');
  near(res.totalAskMassOnPath.Qhi - res.totalAskMassOnPath.Qlo, tb[2], 1e-6, 'upper bound includes the T bin');
  ok(!res.states.some(s => s.code === 'noSubstantialZone'), 'no all-clear'); ok(res.zones.length >= 1 && res.zones.every(z => z.approx.T && z.Q === null && z.verdict !== 'pass' && z.verdict !== 'fail'), 'the T-bin candidate is uncertain: ' + JSON.stringify(res.zones.map(z => [z.verdict, z.materiality, z.concentration])));
});
t('B2 fixture 1b: T exactly at the finite upper grid edge -> tail mass is unresolved (upper bound only), no all-clear', () => {
  const g = G(2), r = cb(upTo(119).concat([[125, 50]]), null, g), base = S.activityBaseline(krakenRows(168, 1, 1), 'kraken', H), res = S.sellObstacleZones(r, g, 110, 120, base, P, CUT);
  ok(r.bins.a.some(x => x[0] === g.edges.length), 'the ask beyond the grid is in the tail'); ok(res.totalAskMassOnPath.tailAtTarget > 0 && res.totalAskMassOnPath.Qhi >= res.totalAskMassOnPath.Qlo + res.totalAskMassOnPath.tailAtTarget - 1e-9, 'tail adds to the upper bound only');
  ok(res.states.some(s => s.code === 'boundaryUnresolved') && !res.states.some(s => s.code === 'noSubstantialZone'), 'flagged, no all-clear');
});
t('B2 fixture 2: E 124.5, cluster 124-126 holding 10,000 below E and 10 inside the path -> Q 10-10,010, C bounds, verdict uncertain (not a definite pass)', () => {
  const g = G(3), base = S.activityBaseline(krakenRows(168, 1, 1), 'kraken', H), asks = []; for (let k = 101; k <= 139; k++) { if (k === 124) asks.push([124.2, 10000 / 124.2]); else if (k === 125) asks.push([125.2, 10 / 125.2]); else asks.push([k + 0.5, 1 / (k + 0.5)]); }
  const r = cb(asks, null, g);
  const res = S.sellObstacleZones(r, g, 124.5, 140, base, P, { concentration: 100, material: 5, asOfMs: ASOF, maxAgeMs: 1800000 }), z = res.zones.filter(q => q.lo <= 124 + 1e-9 && q.hi >= 126 - 1e-9)[0];
  ok(!!z, 'cluster found: ' + JSON.stringify(res.zones.map(q => [q.lo, q.hi])));
  near(z.Qlo, 10, 1e-6); near(z.Qhi, 10010, 1e-6); ok(z.CApprox && z.CHi > 1000 && z.CLo < 10, 'C bounds: ' + z.CLo + ' .. ' + z.CHi);
  eq(z.concentration, 'uncertain'); ok(z.verdict !== 'pass', 'not a definite pass: ' + z.verdict); ok(!res.qualifying.includes(z.id));
});
t('B2: exact interior candidates are unchanged (no C bounds, same verdicts as before)', () => {
  const g = G(3), r = wallAt(110.55, 400), res = S.sellObstacleZones(r, g, 100.5, 120, baseK(100), P, CUT);
  ok(res.zones.length >= 1 && res.zones.every(z => !z.CApprox && z.CLo === undefined && z.CHi === undefined), 'no bounds fields on exact zones'); ok(res.zones.every(z => z.CStatus === 'ok'));
});

// ---- item 52p: venue context (Astra Venue-Share Calibration Ruling) ----
function krRows24(skipK) { const rows = []; for (let k = 0; k < 24; k++) { if (k === skipK) continue; rows.push([(H - 24 * HR + k * HR) / 1000, 10, 10, 10, 10, 10, 100, 5]); } return rows; }   // 1000 quote per hour
const GL = (over) => Object.assign({ coinId: 'ether-fi', endpoint: 'coins/markets', vsCurrency: 'usd', value: 40100000, lastUpdatedMs: H + 120000, retrievedAtMs: H + 180000, responseSha256: 'ab'.repeat(32) }, over || {});
t('52p local 24 h turnover: Kraken exact (vwap x volume), window [H-24h, H), all 24 hours listed', () => {
  const l = S.localTurnover24h(krRows24(), 'kraken', H); eq(l.status, 'complete'); eq(l.hours.length, 24); eq(l.total.quote, 24000); eq([l.total.lo, l.total.hi], [24000, 24000]); eq(l.window.startMs, H - 24 * HR); eq(l.window.endMs, H); eq(l.exact, true);
});
t('52p local 24 h turnover: Coinbase estimate with low/high bounds', () => {
  const rows = []; for (let k = 0; k < 24; k++) rows.push([(H - 24 * HR + k * HR) / 1000, 9, 11, 10, 10, 100]); const l = S.localTurnover24h(rows, 'coinbase', H); eq(l.total.quote, 24000); eq(l.total.lo, 21600); eq(l.total.hi, 26400); eq(l.exact, false);
});
t('52p local 24 h turnover: a missing hour leaves the complete total unavailable, subtotal and count retained, no invented zero candle', () => {
  const l = S.localTurnover24h(krRows24(7), 'kraken', H); eq(l.status, 'unavailable'); eq(l.total, null); eq(l.subtotal.count, 23); eq(l.subtotal.quote, 23000); eq(l.missingHours, [H - 24 * HR + 7 * HR]); ok(l.hours[7].valid === false && l.hours[7].quote === null);
});
t('52p local 24 h turnover does not inherit the 120/168-hour baseline floor (24 valid hours is complete)', () => { eq(S.localTurnover24h(krRows24(), 'kraken', H).status, 'complete'); });
t('52p venue context: ratios, bounds, comparability, labels (35k / 40.1M = 0.0873 %)', () => {
  const l = S.localTurnover24h(krRows24(), 'kraken', H), c = S.venueContext(l, GL(), 'USD', H + 60000, { Q: 35000, Qlo: 35000, Qhi: 35000 });
  eq(c.label, 'reported global 24 h volume'); near(c.zoneShareGlobal24h.value, 35000 / 40100000, 1e-12); near(c.pairShare24h.value, 24000 / 40100000, 1e-12); eq(c.comparability.status, 'ok'); eq(c.comparability.differenceMs, 120000); eq(c.comparability.localWindowEndMs, H); eq(c.comparability.conversion, null);
  const cz = S.venueContext(l, GL(), 'USD', H, { Q: null, Qlo: 10, Qhi: 10010 }); eq(cz.zoneShareGlobal24h.value, null); near(cz.zoneShareGlobal24h.lo, 10 / 40100000, 1e-12); near(cz.zoneShareGlobal24h.hi, 10010 / 40100000, 1e-12);
  ok(!/not a price obstacle|local-to-venue/i.test(JSON.stringify(c)), 'no price-impact wording');
});
t('52p venue context: unavailable cases (missing hour, stale / missing / nonpositive / incompatible global, older cutoff without a snapshot)', () => {
  const full = S.localTurnover24h(krRows24(), 'kraken', H), Q = { Q: 100, Qlo: 100, Qhi: 100 };
  const miss = S.venueContext(S.localTurnover24h(krRows24(3), 'kraken', H), GL(), 'USD', H, Q); eq(miss.pairShare24h.status, 'unavailable'); ok(/missing hours/.test(miss.pairShare24h.reason)); eq(miss.zoneShareGlobal24h.status, 'ok');
  eq(S.venueContext(full, GL({ lastUpdatedMs: H - 5 * HR }), 'USD', H, Q).pairShare24h.status, 'unavailable');
  eq(S.venueContext(full, null, 'USD', H, Q).zoneShareGlobal24h.status, 'unavailable'); eq(S.venueContext(full, GL({ value: 0 }), 'USD', H, Q).pairShare24h.status, 'unavailable'); eq(S.venueContext(full, GL({ value: null }), 'USD', H, Q).pairShare24h.status, 'unavailable');
  const inc = S.venueContext(full, GL(), 'USDT', H, Q); eq(inc.pairShare24h.status, 'unavailable'); ok(/incompatible currency/.test(inc.pairShare24h.reason));
  const old = S.venueContext(full, GL({ lastUpdatedMs: H + 3 * 86400000, retrievedAtMs: H + 3 * 86400000 }), 'USD', H, Q); eq(old.zoneShareGlobal24h.status, 'unavailable'); ok(/never today's value/.test(old.zoneShareGlobal24h.reason));
});

// ---- item 52p B1: baseline hour comes from the record, not the cutoff (Astra fixture: record 09:59, cutoff 10:01) ----
t('B1 cross-hour fixture: record received 09:59, cutoff 10:01 -> the record\'s window (median 550, Q 750 passes M>=1), not the cutoff\'s (median 1000, M 0.75)', () => {
  const H9 = Date.UTC(2026, 9, 14, 9, 0, 0), rows = []; for (let k = 0; k <= 168; k++) { const v = k <= 83 ? 100 : 1000; rows.push([(H9 - 168 * HR + k * HR) / 1000, 1, 1, 1, 1, 1, v, 5]); }   // vwap 1 x volume v = quote v per hour; hour k = H9-168h+k h (k = 168 is the 09:00 hour)
  const recv = '2026-10-14T09:59:00.000Z', cutMs = Date.UTC(2026, 9, 14, 10, 1, 0), bh = S.baselineHour(recv), cutH = Math.floor(cutMs / HR) * HR;
  eq(bh, H9); eq(cutH, H9 + HR);
  const live = S.activityBaseline(rows, 'kraken', bh), viaCutoff = S.activityBaseline(rows, 'kraken', cutH); eq([live.status, live.validHours, live.median], ['complete', 168, 550]); eq([viaCutoff.status, viaCutoff.validHours, viaCutoff.median], ['complete', 168, 1000]);
  near(750 / live.median, 1.3636363636, 1e-6); near(750 / viaCutoff.median, 0.75, 1e-9); ok(750 / live.median >= 1 && 750 / viaCutoff.median < 1, 'M>=1 under the live definition, not under the cutoff window');
  eq(S.baselineHour(Date.UTC(2026, 9, 14, 9, 0, 0)), H9); eq(S.baselineHour('2026-10-14T09:00:00.000Z'), H9);
});
console.log('sellzone-core tests: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
