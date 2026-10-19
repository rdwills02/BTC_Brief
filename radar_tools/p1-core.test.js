/* radar_tools/p1-core.test.js — item 52s acceptance B: p1-core.js (P1 Practitioner arm) fixtures. Node only, deterministic, no network, no clock.
 * Run: node radar_tools/p1-core.test.js [p1-core.js] [orders-core.js] [fib-core.js] [episodes-core.js] [capture.js]   -> "p1-core tests: n passed, m failed". Exit 1 on any failure.
 * 52v (freeze blockers B1-B3, Astra Freeze Record Review 2026-10-18): opening-gap fixtures (full P&L), rung net-positive with the 85 bp entry charge, frozen-status calendar / identity guard through the real capture.js wrapper (vm, isolated temp files, deterministic I/O).
 * Required fixtures (IMP 52s §5): all-16-gates (five retained pass, ten omitted fail -> eligible); width-fail not filtered by a hidden screen; invalidation 95 vs stop 99 -> S = 95 rounded up; same marks / different excursions;
 * multi-rung + stop conflict in one bar (stop first); early-L all-out then late-T open -> no re-arm until both terminal; duplicate zone across three fib levels -> one rung; unavailable / bounded M -> no tier;
 * stale zone excluded before slot consumption; zero-lot partial -> not a rung; causal fib confirmation; unresolved twin -> pair unresolved; last-window fill through D+2 gets 20 holding days; horizon isolation (OrdersCore.CFG.HORIZON_BAR = 10). */
'use strict';
var path = require('path');
var here = __dirname, root = path.resolve(here, '..');
var P1_PATH = path.resolve(process.argv[2] || path.join(root, 'p1-core.js')), OC_PATH = path.resolve(process.argv[3] || path.join(root, 'orders-core.js')), FIB_PATH = path.resolve(process.argv[4] || path.join(root, 'radar_tools', 'zones', 'fib-core.js')), EC_PATH = path.resolve(process.argv[5] || path.join(root, 'episodes-core.js'));
var CAPTURE_PATH = path.resolve(process.argv[6] || path.join(root, 'capture.js'));   // 52v B3 wrapper fixtures run the REAL fwdP1Step from this file in a vm
var P1 = require(P1_PATH);
var OC = require(OC_PATH);
var FIB = null; try { FIB = require(FIB_PATH); } catch (e) { FIB = null; }
var EC = null; try { EC = require(EC_PATH); } catch (e) { EC = null; }
var CFG_BEFORE = JSON.stringify(OC.CFG);
var pass = 0, fail = 0, WRAPPER_ASYNC = false;
function ok(c, name, detail) { if (c) pass++; else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); } }
function eq(a, b, name) { var A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, name, { got: a, want: b }); }
var DAY = 86400, BAR5 = 300, D0 = Date.UTC(2026, 9, 20) / 1000;   // D = 2026-10-20 00:00Z
function cfg(o) { return Object.assign({ X_low: 3, X_high: 10, F: 0.5, Y: 0.02, B: 225, referenceCapitalUsd: 15000, horizonHoldingDays: 20, expiry: 'end-D+2', costScenario: 'base', quoteFreshnessMs: 30000, ratios: [0.618, 0.705, 0.786, 1.272, 1.618], coincidencePct: 1, status: 'unfrozen', frozenAt: null, pinned: {} }, o || {}); }
var C = cfg();
function cap(dayOffset, hh, mm) { var iss = D0 + (dayOffset || 0) * DAY + (hh == null ? 0 : hh) * 3600 + (mm == null ? 29 : mm) * 60; return { captureId: 'c' + (dayOffset || 0), generationId: 'c' + (dayOffset || 0), date: new Date((D0 + (dayOffset || 0) * DAY) * 1000).toISOString().slice(0, 10), issueTimeUtc: new Date(iss * 1000).toISOString(), issueSec: iss, inputCutoffSec: D0 + (dayOffset || 0) * DAY }; }
var META = { tick: 0.01, lot: 1, minOrder: 1 };   // lot 1 unit so lot counts read as units in the fixtures (B / (L - S) = 225 / 5 = 45 lots)
function gates(failIds, missingIds) { failIds = failIds || []; missingIds = missingIds || []; return P1.ALL_GATES.filter(function (id) { return missingIds.indexOf(id) < 0; }).map(function (id) { return { id: id, pass: failIds.indexOf(id) < 0, value: 1, threshold: 1 }; }); }
function row(o) { o = o || {}; return { fit: { fitId: 'f', invalidation: o.inv == null ? 95 : o.inv, lifecycleState: 'intact', atr14: 1 }, price: o.price == null ? 100 : o.price, gates: o.gates || gates(), entryEconomics: { entryZone: o.zone || [99, 100], stop: o.stop == null ? 99 : o.stop, target: o.target == null ? 120 : o.target, targetSource: o.targetSource || 'independent', stopBasis: 'defended-low', netRR: 2 } }; }
var CTX = { pair: 'XUSD', venueEligible: true, meta: META };
function geo(o) { return P1.orderGeometry(row(o), META, C); }
function zone(id, lo, hi, Mlo, verdict) { return { id: id, lo: lo, hi: hi, verdict: verdict || 'pass', Mlo: Mlo, Mhi: Mlo == null ? null : Mlo * 2, MhiUnbounded: false }; }
function fibs(prices) { return { available: true, reason: null, levels: C.ratios.map(function (r, i) { return { ratio: r, kind: r < 1 ? 'retracement' : 'extension', price: prices[i] }; }) }; }
function zonesOf(list, states) { return { available: true, reason: null, states: states || [], zones: list }; }
function quote(ts, ask) { return { tSubSec: ts, quoteObservedAtSec: ts - 1, ask: ask, bid: ask - 0.02, last: ask - 0.01 }; }
function opp(o) { o = o || {}; return { cgId: o.cgId || 'x', pair: 'XUSD', venue: 'kraken', entryKind: 'zone', zone: { Elo: 99, Ehi: 100, envelopeHi: 102 } }; }
function pairWith(plan, o) { o = o || {}; var g = geo(o.geo), c = o.cap || cap(0); return P1.newPair(opp(o), g, plan || P1.ladderPlan(null, null, g, C), o.quote === undefined ? quote(c.issueSec + 5, 100.5) : o.quote, c, C); }
function tOnly(g) { return P1.ladderPlan(null, null, g || geo(), C); }
function bar5(id, o, h, l, c) { return { id: id, open: o, high: h, low: l, close: c }; }
function flat5(fromSec, toSec, px) { var out = []; for (var t = Math.floor(fromSec / BAR5) * BAR5; t < toSec; t += BAR5) out.push(bar5(t, px, px + 0.1, px - 0.1, px)); return out; }
function daily(id, o, h, l, c) { return { id: id, time: id, open: o, high: h, low: l, close: c }; }
function flatDaily(fromDay, nDays, px) { var out = []; for (var i = 0; i < nDays; i++) out.push(daily(D0 + (fromDay + i) * DAY, px, px + 0.5, px - 0.5, px)); return out; }
function adj(P, dayOffset, ev) { var c = cap(dayOffset, 0, 29); return P1.adjudicatePair(P, Object.assign({ capture: c, candles: [], bars5: [], trades: [] }, ev || {}), C); }
// fill the pair on day 0 by a full 5-minute bar touching L - tick at 01:00, then 5-minute bars at px for the rest of day 0 (no exit), evaluated on day 1
function filledPair(plan, px, o) {
  var P = pairWith(plan, o), sub = P.submission.submittedAtSec, b0 = Math.floor(sub / BAR5) * BAR5, t0 = b0 + BAR5, L = P.geometry.L;
  var bars = [bar5(b0, L + 0.5, L + 0.6, L + 0.3, L + 0.5), bar5(t0, L + 0.2, L + 0.3, L - 0.01, L + 0.1)].concat(flat5(t0 + BAR5, D0 + DAY, px == null ? 101 : px));   // the submission-straddling bar (range clear of L - tick), then the fill bar
  var r = adj(P, 1, { bars5: bars, candles: [] });
  return r.pair;
}

// ---------- configuration ----------
eq(P1.validateConfig(C), [], 'config: the registered constants validate');
ok(P1.validateConfig(cfg({ expiry: 'end-D+3' })).length === 1 && P1.validateConfig(cfg({ costScenario: 'none' })).length === 1 && P1.validateConfig(cfg({ X_low: 11 })).length === 1 && P1.validateConfig(cfg({ status: 'frozen' })).some(function (e) { return /frozenAt/.test(e); }), 'config: expiry, cost scenario, X_low <= X_high and frozen-without-frozenAt are rejected');
var PIN = {}; P1.PINNED_REQUIRED.forEach(function (k, i) { PIN[k] = String(i).repeat(64).slice(0, 64); });   // nine well-formed (fake) sha256 values
var FROZEN = cfg({ status: 'frozen', frozenAt: '2026-10-20T00:00:00.000Z', pinned: Object.assign({ capture: null, analysis: null }, PIN) });
ok(P1.isStudy(C) === false && P1.isStudy(FROZEN) === true, 'config: unfrozen -> study false; frozen -> study true (declared status only; issuance is studyPhase)');
eq(P1.validateConfig(FROZEN), [], 'config: frozen with frozenAt + nine pinned sha256 validates');
(function () {   // 52v B3(a)
  var e = P1.validateConfig(cfg({ status: 'frozen', frozenAt: '2026-10-20T00:00:00.000Z', pinned: {} }));
  ok(e.length === 9 && P1.PINNED_REQUIRED.every(function (k) { return e.some(function (m) { return m.indexOf('pinned.' + k) === 0; }); }), 'FIXTURE B3 empty pinned with status frozen -> config rejected (one error per required identity)', e);
  ok(P1.validateConfig(cfg({ status: 'frozen', frozenAt: '2026-10-20T00:00:00.000Z', pinned: Object.assign({}, PIN, { channelCore: 'abc' }) })).length === 1, 'B3(a): a malformed hash (channel-core) is rejected');
  ok(P1.validateConfig(cfg({ status: 'frozen', frozenAt: '2026-10-20T00:00:00.000Z', pinned: Object.assign({}, PIN, { bookCodec: null }) })).length === 1, 'B3(a): a null hash (book-codec) is rejected when frozen');
  eq(P1.validateConfig(cfg({ pinned: { capture: null, p1Core: null, ordersCore: null, episodesCore: null, channelCore: null, bookCore: null, bookCodec: null, sellzoneCore: null, sellzoneParams: null, fibCore: null, analysis: null } })), [], 'B3(a): unfrozen with null pinned values (the shipped p1-config shape) still validates');
  ok(P1.PINNED_REQUIRED.indexOf('channelCore') >= 0 && P1.PINNED_REQUIRED.indexOf('bookCodec') >= 0 && P1.PINNED_FILES.channelCore === 'channel-core.js' && P1.PINNED_FILES.bookCodec === 'radar_tools/book/book-codec.js', 'identity manifest: channel-core.js and radar_tools/book/book-codec.js are required pinned identities');
  var idOk = P1.identityCheck(FROZEN, Object.assign({}, PIN)), idBad = P1.identityCheck(FROZEN, Object.assign({}, PIN, { p1Core: 'f'.repeat(64) })), idMissing = P1.identityCheck(FROZEN, Object.assign({}, PIN, { sellzoneParams: undefined }));
  ok(idOk.ok && !idBad.ok && idBad.mismatches.length === 1 && idBad.mismatches[0].key === 'p1Core' && !idMissing.ok && idMissing.mismatches[0].key === 'sellzoneParams', 'identityCheck: equal -> ok; one differing or missing hash -> that key mismatched');
})();
(function () {   // 52v B3(b): Astra's October 20 example - issuance through Dec 18 (exclusive Dec 19), fills through Dec 20 (excl. Dec 21), twenty holding days through Jan 8 (excl. Jan 9), evidence through Jan 15 (excl. Jan 16)
  var cal = P1.deriveCalendar('2026-10-20', 20);
  eq([cal.anchor, cal.issuanceStart, cal.issuanceEndExclusive, cal.fillEndExclusive, cal.horizonEndExclusive, cal.evidenceDeadlineExclusive], ['2026-10-20', '2026-10-20T00:00:00.000Z', '2026-12-19T00:00:00.000Z', '2026-12-21T00:00:00.000Z', '2027-01-09T00:00:00.000Z', '2027-01-16T00:00:00.000Z'], 'FIXTURE B3 calendar: Astra\'s Oct-20 anchor gives Dec 19 / Dec 21 / Jan 9 / Jan 16 exclusive bounds');
  ok((Date.parse(cal.issuanceEndExclusive) - Date.parse(cal.issuanceStart)) / 864e5 === 60, 'calendar: exactly sixty inclusive issuance dates');
  eq(P1.validateCalendar(cal), [], 'calendar: the derived calendar validates');
  ok(P1.validateCalendar(Object.assign({}, cal, { horizonEndExclusive: '2027-01-10T00:00:00.000Z' })).length === 1 && P1.validateCalendar(Object.assign({}, cal, { anchor: 'nope' })).length === 1 && P1.validateCalendar(null).length === 1, 'calendar: a bound that is not the derived one, a bad anchor, or no object is rejected');
  ok(P1.validateConfig(Object.assign({}, FROZEN, { calendar: cal })).length === 0 && P1.validateConfig(Object.assign({}, FROZEN, { calendar: Object.assign({}, cal, { fillEndExclusive: '2026-12-22T00:00:00.000Z' }) })).length === 1, 'config: a calendar written into the config must be the derived one');
  var capAt = function (date, hh) { var t = Date.parse(date + 'T00:00:00.000Z') / 1000 + (hh == null ? 0 : hh) * 3600 + 29 * 60; return { captureId: 'x', date: date, issueSec: t, inputCutoffSec: Date.parse(date + 'T00:00:00.000Z') / 1000 }; };
  var dev = P1.studyPhase(C, null, capAt('2026-10-20')), pre = P1.studyPhase(FROZEN, null, capAt('2026-10-19')), anchor = P1.studyPhase(FROZEN, null, capAt('2026-10-20'));
  ok(dev.phase === 'development' && dev.study === false && dev.issue === true, 'studyPhase: unfrozen -> development issuance, study:false');
  ok(pre.phase === 'pre-freeze' && pre.study === false && pre.issue === true && pre.calendar === null, 'studyPhase: frozen, capture before frozenAt -> development issuance (study:false), no calendar yet');
  ok(anchor.phase === 'study-issuance' && anchor.study === true && anchor.anchorNow === true && anchor.calendar.anchor === '2026-10-20', 'studyPhase: first capture at/after frozenAt anchors the calendar and issues study pairs');
  var late = P1.studyPhase(FROZEN, null, capAt('2026-10-22'));
  ok(late.anchorNow && late.calendar.anchor === '2026-10-22' && late.calendar.issuanceEndExclusive === '2026-12-21T00:00:00.000Z', 'studyPhase: a missed 10-20 capture moves the anchor (and the whole calendar) to the first capture that happened');
  var last = P1.studyPhase(FROZEN, cal, capAt('2026-12-18')), end = P1.studyPhase(FROZEN, cal, capAt('2026-12-19')), after = P1.studyPhase(FROZEN, cal, capAt('2026-12-20'));
  ok(last.phase === 'study-issuance' && last.study && last.issue && !last.anchorNow, 'studyPhase: last issuance day (Dec 18) issues study pairs from the persisted calendar');
  ok(end.phase === 'post-issuance' && !end.study && !end.issue && after.phase === 'post-issuance' && !after.issue, 'studyPhase: issuanceEndExclusive (Dec 19) and after -> adjudication only, nothing new');
  var noon = cfg({ status: 'frozen', frozenAt: '2026-10-20T12:00:00.000Z', pinned: PIN }), fz = P1.studyPhase(noon, null, capAt('2026-10-20')), fz2 = P1.studyPhase(noon, null, capAt('2026-10-21'));
  ok(fz.phase === 'pre-freeze' && fz2.anchorNow && fz2.calendar.anchor === '2026-10-21', 'studyPhase: the 00:29Z capture before a noon frozenAt is pre-freeze; the next capture anchors');
})();
eq(P1.chargesOf(C), { scenario: 'base', makerBp: 30, takerBp: 60, frictionBaseBp: 10, frictionAdverseBp: 25, mode: 'base' }, "config: charges come from the existing 'base' scenario");

// ---------- eligibility (BLOCKS A) ----------
(function () {
  var r = row({ gates: gates(P1.GATES.omitted) }), e = P1.eligibility(r, CTX, C);
  ok(e.eligible === true && e.reasons.length === 0, 'FIXTURE all-16-gates: five retained pass, ten omitted fail -> eligible', e.reasons);
  ok(P1.GATES.omitted.every(function (id) { return e.gates[id] === 'fail'; }) && P1.GATES.retained.every(function (id) { return e.gates[id] === 'pass'; }), 'all-16-gates: the ten omitted gates are recorded as fail, the five retained as pass');
  ok(OC.qualify({ requiredGates: P1.ALL_GATES }, { gates: r.gates, price: 100, entryEconomics: r.entryEconomics }) === false, 'all-16-gates: the cohort qualify() with all sixteen required returns false on the same row (Astra consequence)');
})();
(function () {
  var r = row({ gates: gates(['C2.width']), price: 100 }), e = P1.eligibility(r, CTX, C);
  ok(e.eligible === true && e.gates['C2.width'] === 'fail', 'FIXTURE width-fail: C2.width fail is diagnostic only; the row is eligible');
  if (EC && typeof EC.screenOf === 'function') {
    var wide = { fit: { invalidation: 95, channelH: 60, supportNow: 99, lifecycleState: 'intact', atr14: 1 }, price: 100, widthPrice: 100, gates: r.gates, entryEconomics: r.entryEconomics, score: 80 };
    var s = null; try { s = EC.screenOf(wide, { gateFaithful: true }, true, false); } catch (x) { s = { error: x.message }; }
    ok(s && s.pass !== true, 'width-fail: the episode screenOf rejects a 60 %-wide channel (the hidden filter P1 does not inherit)', s);
  } else ok(true, 'width-fail: episodes-core not loaded - screenOf comparison skipped');
})();
(function () {
  var e = P1.eligibility(row({ gates: gates(['struct.lifecycle']) }), CTX, C); ok(!e.eligible && e.reasons[0] === 'gate:struct.lifecycle:fail', 'a retained gate failing -> ineligible with the gate named');
  var e2 = P1.eligibility(row({ gates: gates([], ['struct.below-rail']) }), CTX, C); ok(!e2.eligible && e2.gates['struct.below-rail'] === 'unknown' && e2.reasons[0] === 'gate:struct.below-rail:unknown', 'a retained gate absent from the log row is unknown and does not pass');
  var e3 = P1.eligibility(row({ gates: gates([], ['C5.btc-regime']) }), CTX, C); ok(e3.eligible && e3.gates['C5.btc-regime'] === 'unknown', 'an omitted gate that is unknown does not veto');
})();
(function () {
  var inZ = P1.eligibility(row({ price: 99.5, gates: gates(['C2.entry-zone']) }), CTX, C), env = P1.eligibility(row({ price: 101.9 }), CTX, C), out = P1.eligibility(row({ price: 102.1 }), CTX, C), below = P1.eligibility(row({ price: 98.9 }), CTX, C);
  ok(inZ.eligible && inZ.entryKind === 'zone' && inZ.entryZoneGate.original === 'fail' && inZ.entryZoneGate.override.pass === true, 'entry: Elo <= p <= Ehi -> zone; the original C2.entry-zone result is preserved beside the override');
  ok(env.eligible && env.entryKind === 'envelope' && Math.abs(env.distanceToZoneTopPct - 1.9) < 1e-9, 'entry: Ehi < p <= Ehi x 1.02 -> envelope with distanceToZoneTopPct');
  ok(!out.eligible && out.reasons.indexOf('above-envelope') >= 0 && !below.eligible && below.reasons.indexOf('below-entry-zone') >= 0, 'entry: outside the envelope -> ineligible (above / below named)');
})();
(function () {
  ok(!P1.eligibility(row(), { pair: null, venueEligible: false, meta: META }, C).eligible, 'execution: no designated pair -> ineligible');
  ok(P1.eligibility(row(), { pair: 'XUSD', venueEligible: true, meta: null }, C).reasons.indexOf('metadata-unavailable') >= 0, 'execution: tick / lot / minOrder missing -> ineligible');
  ok(P1.eligibility(row({ price: -1, gates: gates([], ['data.price']) }), CTX, C).reasons.indexOf('price-unavailable') >= 0, 'missing price is not admitted by the gate omission');
  ok(P1.eligibility(row({ targetSource: 'swing-high' }), CTX, C).reasons.indexOf('target-not-independent') >= 0, 'target provenance must be independent');
})();

// ---------- geometry (BLOCKS B) ----------
(function () {
  var g = geo({ inv: 95, stop: 99, price: 100 });
  ok(g.ok && g.S === 95 && g.raw.entryEconomicsStop === 99 && g.stopSource === 'fit.invalidation ceil-to-tick', 'FIXTURE invalidation 95 vs entryEconomics.stop 99 -> S = 95 (never 99)');
  var g2 = geo({ inv: 95.001, price: 100.555, target: 120.004 });
  ok(g2.S === 95.01 && g2.L === 100.55 && g2.T === 120, 'S rounds UP to tick, L and T round DOWN');
  ok(g.Q === 45 && g.qty === 45 && g.Bcents === 22500, 'qty = floorTo(B / (L - S), lot): 225 / 5 = 45 at lot 1');
  var g01 = P1.orderGeometry(row({ inv: 95, stop: 99, price: 100 }), { tick: 0.01, lot: 0.01, minOrder: 0.01 }, C); ok(g01.Q === 4500 && g01.qty === 45 && g01.lotsInv === 100, 'qty at lot 0.01: 4,500 lots = 45 units');
  ok(!geo({ inv: 100.5 }).ok && geo({ inv: 100.5 }).reasons[0] === 'geometry-order', 'S >= L -> rejected');
  ok(!geo({ target: 100 }).ok, 'T <= L -> rejected');
  var tiny = P1.orderGeometry(row({ inv: 1, price: 50000, target: 60000 }), { tick: 0.1, lot: 0.001, minOrder: 0.01 }, C);
  ok(!tiny.ok && tiny.reasons[0] === 'qty-below-minimum', 'qty below the venue minimum -> rejected');
  var z = P1.orderGeometry(row({ inv: 1, price: 100000, target: 120000 }), { tick: 1, lot: 1, minOrder: 1 }, C);
  ok(!z.ok && z.reasons[0] === 'qty-zero', 'zero lots -> rejected');
})();

// ---------- ladder (B3) ----------
(function () {
  var g = geo(), lv = fibs([104, 106, 108, 112, 116]);
  var p = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4), zone('b', 105.8, 106.2, 12), zone('c', 115, 117, 5)]), lv, g, C);
  eq(p.rungs.map(function (r) { return [r.price, r.zoneId, r.tier, r.lots]; }), [[104, 'a', 'fraction', 22], [106, 'b', 'all', 23]], 'ladder: fraction rung then all-out rung; nothing after the all-out');
  ok(p.rejected.some(function (r) { return r.reason === 'after-all-out-rung' && r.rungPrice === 116; }) && p.tOnly === false && p.fallbackReason === null && p.remainingAfterLadder === 0, 'ladder: later coincident zone rejected after the all-out rung');
  var dup = P1.ladderPlan(zonesOf([zone('wide', 103, 109, 5)]), lv, g, C);
  ok(dup.rungs.length === 1 && dup.rungs[0].zoneId === 'wide' && dup.rejected.filter(function (r) { return r.reason === 'no-coincident-zone'; }).length >= 2, 'FIXTURE duplicate zone across three fib levels -> one rung (zone consumed once)');
  var nb = P1.ladderPlan(zonesOf([zone('u', 103.5, 104.5, null), zone('v', 105.8, 106.2, 5)]), lv, g, C);
  ok(nb.rungs.length === 1 && nb.rungs[0].zoneId === 'v' && nb.rejected.some(function (r) { return r.id === 'u' && r.reason === 'bounded-unavailable'; }), 'FIXTURE unavailable / bounded M -> no tier for that zone; the slot is not consumed');
  var st = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)], ['stale']), lv, g, C);
  ok(st.tOnly && st.fallbackReason === 'input-unavailable' && st.rejected.some(function (r) { return r.id === 'a' && r.reason === 'stale'; }), 'FIXTURE stale depth record -> every zone excluded before slot consumption, T-only input-unavailable');
  var unc = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4, 'uncertain'), zone('b', 105.8, 106.2, 4)]), lv, g, C);
  ok(unc.rungs.length === 1 && unc.rungs[0].zoneId === 'b' && unc.rungs[0].lots === 22, 'uncertain zone filtered before slot consumption: the first slot goes to the next coincident pass zone with the full remaining base');
  var bt = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 2.9), zone('b', 105.8, 106.2, 1)]), lv, g, C);
  ok(bt.tOnly && bt.fallbackReason === 'all-below-tier', 'coincident pass zones all below X_low -> T-only all-below-tier');
  var nc = P1.ladderPlan(zonesOf([zone('far', 130, 131, 20)]), lv, g, C);
  ok(nc.tOnly && nc.fallbackReason === 'no-confluence', 'no coincident zone -> T-only no-confluence');
  var tie = P1.ladderPlan(zonesOf([zone('z2', 103.6, 104.4, 5), zone('z1', 103.5, 104.5, 5)]), lv, g, C);
  ok(tie.rungs[0].zoneId === 'z1', 'ladder: equal M lower bounds tie by stable zone id');
  var best = P1.ladderPlan(zonesOf([zone('lo', 103.6, 104.4, 5), zone('hi', 103.5, 104.5, 12)]), lv, g, C);
  ok(best.rungs[0].zoneId === 'hi' && best.rungs[0].tier === 'all', 'ladder: the coincident zone with the greatest M lower bound is chosen');
  var g1 = P1.orderGeometry(row({ inv: 775, price: 1000, target: 1200 }), { tick: 0.01, lot: 1, minOrder: 1 }, C);   // L - S = 225 -> B / 225 = exactly 1 lot
  ok(g1.ok && g1.Q === 1, 'setup: a geometry with exactly one lot');
  var zl = P1.ladderPlan(zonesOf([zone('a', 1035, 1045, 4), zone('b', 1058, 1062, 12)]), fibs([1040, 1060, 1080, 1120, 1160]), g1, C);
  ok(zl.rungs.length === 1 && zl.rungs[0].zoneId === 'b' && zl.rungs[0].tier === 'all' && zl.rejected.some(function (r) { return r.reason === 'zero-lot-partial' && r.zoneId === 'a'; }), 'FIXTURE zero-lot partial -> not a rung; the all-out rung still forms');
  var dp = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4), zone('b', 103.5, 104.6, 4)]), fibs([104.001, 104.002, 108, 112, 116]), g, C);
  ok(dp.rungs.length === 1 && dp.rejected.some(function (r) { return r.reason === 'duplicate-price'; }), 'identical rounded rung prices are deduplicated');
  var ne = P1.ladderPlan(zonesOf([zone('a', 99.5, 100.6, 20), zone('b', 119.5, 120.5, 20)]), fibs([100.2, 120, 108, 112, 116]), g, C);
  ok(ne.rejected.some(function (r) { return r.reason === 'not-net-positive'; }) && ne.rejected.some(function (r) { return r.reason === 'at-or-above-target'; }), 'a rung must be net-positive under the declared costs and strictly below T');
  var nf = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)]), { available: false, reason: 'nonpositive leg', levels: [] }, g, C);
  ok(nf.tOnly && nf.fallbackReason === 'input-unavailable', 'no fib leg -> T-only input-unavailable');
})();
if (FIB) (function () {   // FIXTURE causal fib confirmation: a leg whose confirming candle closes AFTER the decision time is not available at that decision
  var cs = [], t0 = D0 - 40 * DAY, px = 100;
  for (var i = 0; i < 40; i++) { var lo = px - 1, hi = px + 1; if (i === 10) lo = 90; if (i === 30) hi = 130; cs.push({ time: t0 + i * DAY, open: px, high: hi, low: lo, close: px }); }
  var confirmedAt = (t0 + 35 * DAY) + DAY;   // pivot high at 30 confirms when candle 35 closes
  var late = FIB.compute(cs, { intervalSec: DAY, nowMs: (confirmedAt + 3600) * 1000 }, {}), early = FIB.compute(cs, { intervalSec: DAY, nowMs: (confirmedAt - 3600) * 1000 }, {});
  ok(late.status === 'ok' && late.leg.high === 130 && late.leg.confirmedAt === confirmedAt, 'causal fib: after the confirming close the 90 -> 130 leg is available');
  ok(early.status !== 'ok' || early.leg.high !== 130, 'FIXTURE causal fib confirmation: at a decision time before the confirming close, the 90 -> 130 leg is NOT available');
  var fl = { available: early.status === 'ok' && early.leg.confirmedAt * 1000 <= (confirmedAt - 3600) * 1000, reason: early.reason || 'not-confirmed-at-decision', levels: early.levels };
  var pl = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)]), fl, geo(), C);
  ok(pl.tOnly && pl.fallbackReason === 'input-unavailable', 'causal fib: the plan falls back to T-only input-unavailable');
})(); else ok(true, 'fib-core not loaded - causal fixture skipped');

// ---------- submission ----------
(function () {
  var c = cap(0), P = pairWith(tOnly(), { cap: c });
  ok(P.entry.status === 'resting' && P.submission.quoteStatus === 'ok' && P.entry.expiryAtSec === D0 + 3 * DAY && P.study === false && P.twins.T.remainingLots === P.geometry.Q && P.twins.L.remainingLots === P.geometry.Q, 'submission: ask above L rests at L; expiry end-D+2; study false while unfrozen; both twins hold the issue quantity');
  var x = pairWith(tOnly(), { quote: quote(c.issueSec + 5, 99.9) });
  ok(x.entry.status === 'open' && x.entry.fill.reason === 'fill-crossing-ask' && x.entry.fill.price === 99.9 && x.entry.fill.kind === 'taker' && x.position.hDone === 0, 'submission: ask at/below L fills now at the ask (taker, adverse), quantity preserved');
  var inv = pairWith(tOnly(), { quote: quote(c.issueSec + 5, 94) });
  ok(inv.entry.status === 'rejected-invalid-at-submission' && P1.statusOf(inv) === 'terminal-unfilled', 'submission: ask at/below S -> rejected-invalid-at-submission');
  ok(P.submission.quoteState === 'fresh' && P.submission.quoteAgeMs === 1000 && P.status === 'pending', 'submission: a usable quote is recorded fresh with its age; the new pair carries status pending');
  ok(pairWith(tOnly(), { quote: quote(c.issueSec + 5, 99.9) }).status === 'open' && pairWith(tOnly(), { quote: quote(c.issueSec + 5, 94) }).status === 'terminal-unfilled', 'submission: status is written on the record at creation (open / terminal-unfilled)');
  // analysis-thread ruling 2026-10-16: a missing or stale quote RESTS at L (the cohort's rule), never rejects
  var qm = pairWith(tOnly(), { quote: { tSubSec: c.issueSec + 5, missing: true, error: 'HTTP 503' } });
  ok(qm.entry.status === 'resting' && qm.submission.quoteState === 'missing' && qm.submission.quoteAgeMs === null && qm.submission.quote === null && qm.submission.submittedAtSec === c.issueSec + 5, 'FIXTURE missing quote -> resting at L from the attempted-fetch time (quoteState missing)');
  var sub = qm.submission.submittedAtSec, b0 = Math.floor(sub / BAR5) * BAR5, t0 = b0 + BAR5, L = qm.geometry.L, pre = bar5(b0, L + 0.5, L + 0.6, L + 0.3, L + 0.5);
  var qmFill = adj(qm, 1, { bars5: [pre, bar5(t0, L + 0.2, L + 0.3, L - 0.01, L + 0.1)].concat(flat5(t0 + BAR5, D0 + DAY, 101)) }).pair;
  ok(qmFill.entry.status === 'open' && qmFill.entry.fill.price === L && qmFill.entry.fill.reason === 'limit', 'missing quote: a later print at/below L - tick fills the resting order at L');
  var qmRest = adj(qm, 1, { bars5: flat5(b0, D0 + DAY, 101) }).pair;
  ok(qmRest.entry.status === 'resting' && qmRest.entry.eligibleDone === 1, 'missing quote: later prices above L keep it resting (window 0 no-fill)');
  var stale = pairWith(tOnly(), { quote: { tSubSec: c.issueSec + 60, quoteObservedAtSec: c.issueSec + 5, ask: 99.5 } });
  ok(stale.entry.status === 'resting' && stale.submission.quoteState === 'stale' && stale.submission.quoteAgeMs === 55000 && stale.submission.quote.ask === 99.5 && !stale.entry.fill, 'FIXTURE stale quote (older than quoteFreshnessMs) -> resting at L, quoteState stale, no fill-at-ask even though the stale ask <= L');
  var staleFill = adj(stale, 1, { bars5: [bar5(Math.floor((c.issueSec + 60) / BAR5) * BAR5, L + 0.5, L + 0.6, L + 0.3, L + 0.5), bar5(Math.floor((c.issueSec + 60) / BAR5) * BAR5 + BAR5, L + 0.2, L + 0.3, L - 0.01, L + 0.1)].concat(flat5(Math.floor((c.issueSec + 60) / BAR5) * BAR5 + 2 * BAR5, D0 + DAY, 101)) }).pair;
  ok(staleFill.entry.status === 'open' && staleFill.entry.fill.price === L, 'stale quote: a later print at/below L - tick fills at L');
  var staleS = pairWith(tOnly(), { quote: { tSubSec: c.issueSec + 60, quoteObservedAtSec: c.issueSec + 5, ask: 94 } });
  ok(staleS.entry.status === 'resting', 'stale quote: the ask <= S rejection applies only to a fresh quote');
})();

// ---------- entry adjudication ----------
(function () {
  var P = pairWith(tOnly()), r0 = adj(P, 0, {});
  ok(r0.pair.entry.status === 'resting' && r0.needs.length === 0, 'entry: on the issue day nothing is due (window 0 ends at the end of D)');
  var r1 = adj(P, 1, {});
  ok(r1.pair.entry.status === 'pending-unresolved' && r1.needs[0].kind === 'bars5' && r1.needs[0].fromSec === P.submission.submittedAtSec, 'entry: window 0 due with no 5-minute bars -> pending-unresolved and a bars5 need');
  var f = filledPair(tOnly(), 101);
  ok(f.entry.status === 'open' && f.entry.fill.reason === 'limit' && f.entry.fill.price === f.geometry.L && f.position.hDone === 1 && P1.statusOf(f) === 'open', 'entry: a full 5-minute bar touching L - tick fills at L (maker); the fill day is holding day 1');
  var Pn = pairWith(tOnly()), sub = Pn.submission.submittedAtSec, b0 = Math.floor(sub / BAR5) * BAR5;
  var e1 = adj(Pn, 1, { bars5: flat5(b0, D0 + DAY, 101) }).pair;
  ok(e1.entry.status === 'resting' && e1.entry.eligibleDone === 1 && e1.entry.cursorSec === D0 + DAY, 'entry: window 0 fully observed without a touch -> no-fill, cursor at D+1');
  var e2 = adj(e1, 2, { candles: [daily(D0 + DAY, 101, 102, 100.5, 101)] }).pair, e3 = adj(e2, 3, { candles: [daily(D0 + DAY, 101, 102, 100.5, 101), daily(D0 + 2 * DAY, 101, 102, 100.5, 101)] }).pair;
  ok(e2.entry.eligibleDone === 2 && e3.entry.status === 'expired' && P1.statusOf(e3) === 'terminal-unfilled', 'entry: D+1 and D+2 daily windows without a touch -> expired after three windows');
  var e2f = adj(e1, 2, { candles: [daily(D0 + DAY, 101, 102, 99.98, 101)] }).pair;
  ok(e2f.entry.status === 'open' && e2f.entry.fill.daily === undefined && e2f.entry.fill.reason === 'limit' && e2f.position.hDone === 1, 'entry: a D+1 daily bar through L - tick fills at L (daily fill, holding day 1 consumed)');
  // partial submission-straddling bar: the range touches L - tick -> Trades decide
  var Pp = pairWith(tOnly()), sb = Math.floor(Pp.submission.submittedAtSec / BAR5) * BAR5;
  var rp = adj(Pp, 1, { bars5: [bar5(sb, 100.6, 100.7, 99.9, 100.6)].concat(flat5(sb + BAR5, D0 + DAY, 101)) });
  ok(rp.pair.entry.status === 'pending-unresolved' && rp.needs.some(function (n) { return n.kind === 'trades' && n.fromSec === Pp.submission.submittedAtSec && n.toSec === sb + BAR5; }), 'entry: the straddling bar whose range touches L - tick asks for covered Trades');
  var pre = { fromSec: Pp.submission.submittedAtSec, toSec: sb + BAR5, complete: true, trades: [{ t: Pp.submission.submittedAtSec - 2, p: 99.9, n: 1 }, { t: Pp.submission.submittedAtSec + 10, p: 100.7, n: 2 }] };
  var rn = adj(Pp, 1, { bars5: [bar5(sb, 100.6, 100.7, 99.9, 100.6)].concat(flat5(sb + BAR5, D0 + DAY, 101)), trades: [pre] });
  ok(rn.pair.entry.status === 'resting' && rn.pair.entry.eligibleDone === 1, 'entry: a pre-submission print at/below L - tick never fills (prints before submission are not eligible)');
  var inc = { fromSec: Pp.submission.submittedAtSec, toSec: sb + BAR5, complete: false, trades: [] };
  var ru = adj(Pp, 1, { bars5: [bar5(sb, 100.6, 100.7, 99.9, 100.6)].concat(flat5(sb + BAR5, D0 + DAY, 101)), trades: [inc] });
  ok(ru.pair.entry.status === 'pending-unresolved' && ru.pair.entry.unresolved.reason === 'trades-unavailable', 'entry: an incomplete Trades slice is unavailable, never an assumed no-event (no OHLC fallback)');
})();

// ---------- position: same marks / different excursions; conflicts; rungs ----------
(function () {
  var plan = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4), zone('b', 105.8, 106.2, 12)]), fibs([104, 106, 108, 112, 116]), geo(), C);
  ok(plan.rungs.length === 2, 'setup: two-rung plan');
  var A = filledPair(plan, 101), B = filledPair(plan, 101), d1 = D0 + DAY;
  var ra = adj(A, 2, { candles: [daily(d1, 101, 101.5, 100.8, 101)] }).pair, rb = adj(B, 2, { candles: [daily(d1, 101, 121, 94, 101)] }).pair;
  ok(ra.twins.T.exits.length === 0 && ra.twins.L.exits.length === 0 && rb.twins.T.exits[0].reason === 'conflict-stop' && rb.twins.L.exits[0].reason === 'conflict-stop' && rb.twins.L.exits.length === 1, 'FIXTURE same marks / different excursions: identical open / close, one bar no event, the other a stop-first conflict on both twins');
  ok(rb.twins.L.rungs.every(function (r) { return !r.filled; }) && rb.twins.L.remainingLots === 0, 'FIXTURE multi-rung + stop conflict in one bar: stop first, no rung credit');
  var rc = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 101, 106.5, 100.8, 105)] }).pair;
  eq(rc.twins.L.exits.map(function (x) { return [x.reason, x.price, x.lots, x.rungK]; }), [['rung', 104, 22, 1], ['rung', 106, 23, 2]], 'two rungs crossed in one bar fill ascending at their prices; the all-out rung closes L');
  ok(rc.twins.L.closed && !rc.twins.T.closed && rc.twins.T.exits.length === 0 && P1.statusOf(rc) === 'open', 'early-L all-out: L closed, T still open -> the pair is open');
  var rg = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 105, 107, 104.8, 106)] }).pair;
  ok(rg.twins.L.exits[0].reason === 'gap-rung' && rg.twins.L.exits[0].price === 105 && rg.twins.L.exits[1].reason === 'rung' && rg.twins.L.exits[1].price === 106, 'gap pricing: a rung gapped over fills at the open; a rung crossed intrabar fills at its price');
  var rt = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 101, 121, 100.5, 119)] }).pair;
  eq(rt.twins.L.exits.map(function (x) { return x.reason; }), ['rung', 'rung'], 'T above the all-out rung: nothing remains for T on the L twin');
  ok(rt.twins.T.exits.length === 1 && rt.twins.T.exits[0].reason === 'target' && rt.twins.T.exits[0].price === 120, 'the T twin exits at T on the same bar');
  var plan1 = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)]), fibs([104, 106, 108, 112, 116]), geo(), C);
  var r1 = adj(filledPair(plan1, 101), 2, { candles: [daily(d1, 101, 121, 100.5, 119)] }).pair;
  eq(r1.twins.L.exits.map(function (x) { return [x.reason, x.lots]; }), [['rung', 22], ['target', 23]], 'T closes the remainder after a fraction rung (dust to the final exit)');
  var r1s = adj(filledPair(plan1, 101), 3, { candles: [daily(d1, 101, 104.5, 100.5, 104), daily(d1 + DAY, 104, 104.2, 94, 95)] }).pair;
  eq(r1s.twins.L.exits.map(function (x) { return [x.reason, x.lots]; }), [['rung', 22], ['stop', 23]], 'stop on the remaining after a partial exit');
  var res = P1.pairResult(r1s);
  ok(res.terminal && res.flags.affected && res.netPnL_L > res.netPnL_T && Math.abs(res.delta - (res.R_L - res.R_T)) < 1e-12 && res.Bcents === 22500, 'pairResult: Δ = R_L − R_T on the same B; the laddered twin beats a full stop');
})();
(function () {   // T-only fallback: L is identical to T
  var A = filledPair(tOnly(), 101), r = adj(A, 3, { candles: [daily(D0 + DAY, 101, 103, 100.5, 102), daily(D0 + 2 * DAY, 102, 121, 101, 119)] }).pair, res = P1.pairResult(r);
  eq(r.twins.L.exits.map(function (x) { return [x.reason, x.price, x.lots]; }), r.twins.T.exits.map(function (x) { return [x.reason, x.price, x.lots]; }), 'T-only fallback: the L twin executes exactly as T');
  ok(res.delta === 0 && res.flags.fallbackTonly && !res.flags.affected, 'T-only fallback: Δ = 0, fallbackTonly flagged, not affected');
})();
(function () {   // no entry-bar profit credit; fill-candle stop honoured
  var P = pairWith(tOnly()), sub = P.submission.submittedAtSec, b0 = Math.floor(sub / BAR5) * BAR5, t0 = b0 + BAR5, L = P.geometry.L, pre = bar5(b0, L + 0.5, L + 0.6, L + 0.3, L + 0.5);
  var r = adj(P, 1, { bars5: [pre, bar5(t0, L + 0.2, 125, L - 0.01, 110)].concat(flat5(t0 + BAR5, D0 + DAY, 110)) }).pair;
  ok(r.entry.fill && r.twins.T.exits.length === 0 && r.twins.L.exits.length === 0 && r.position.cursorSec === D0 + DAY, 'no entry-bar profit credit: a fill bar whose high clears T gives no target');
  var s = adj(P, 1, { bars5: [pre, bar5(t0, L + 0.2, L + 0.3, 94, 96)].concat(flat5(t0 + BAR5, D0 + DAY, 96)) }).pair;
  ok(s.twins.T.exits[0].reason === 'ambiguous-stop' && s.twins.L.exits[0].reason === 'ambiguous-stop' && P1.statusOf(s) === 'terminal', 'fill-candle stop honoured on both twins (ambiguous-stop at S)');
})();
(function () {   // FIXTURE unresolved twin -> pair unresolved
  var P = pairWith(tOnly()), sub = P.submission.submittedAtSec, b0 = Math.floor(sub / BAR5) * BAR5, t0 = b0 + BAR5, L = P.geometry.L;
  var bars = [bar5(b0, L + 0.5, L + 0.6, L + 0.3, L + 0.5), bar5(t0, L + 0.2, L + 0.3, L - 0.01, L + 0.1)].concat(flat5(t0 + BAR5, t0 + 10 * BAR5, 101));   // bars stop at t0 + 10 bars: the rest of the fill day is missing
  var r = adj(P, 1, { bars5: bars });
  ok(r.pair.entry.fill && r.pair.position.unresolved && r.pair.position.unresolved.reason === 'bars5-missing' && P1.statusOf(r.pair) === 'unresolved', 'FIXTURE unresolved: missing fill-day bars after entry -> the pair is unresolved, never "no rung filled"');
  var res = P1.pairResult(r.pair);
  ok(res.flags.unresolved && res.netPnL_T === null && res.delta === null && r.needs.some(function (n) { return n.kind === 'bars5' && n.fromSec === t0 + 10 * BAR5; }), 'unresolved: no P&L, Δ null, the missing interval is a bars5 need');
  var r2 = adj(r.pair, 1, { bars5: bars.concat(flat5(t0 + 10 * BAR5, D0 + DAY, 101)) }).pair;
  ok(!r2.position.unresolved && r2.position.hDone === 1 && P1.statusOf(r2) === 'open', 'unresolved: the interval resolves when the bars arrive');
})();
(function () {   // FIXTURE last-window fill through D+2 gets 20 holding days; horizon exit at the close of day 20
  var P = pairWith(tOnly()), sub = P.submission.submittedAtSec, b0 = Math.floor(sub / BAR5) * BAR5;
  var e1 = adj(P, 1, { bars5: flat5(b0, D0 + DAY, 101) }).pair, e2 = adj(e1, 2, { candles: [daily(D0 + DAY, 101, 102, 100.5, 101)] }).pair;
  var cs = [daily(D0 + DAY, 101, 102, 100.5, 101), daily(D0 + 2 * DAY, 101, 102, 99.98, 101)].concat(flatDaily(3, 19, 103));   // D+2 fills; D+3 .. D+21 flat
  var r = adj(e2, 25, { candles: cs }).pair, res = P1.pairResult(r);
  ok(r.entry.fill && r.entry.fill.dayId === D0 + 2 * DAY && r.position.hDone === 20 && r.twins.T.exits[0].reason === 'horizon' && r.twins.T.exits[0].holdingDay === 20 && r.twins.T.exits[0].barId === D0 + 21 * DAY, 'FIXTURE last-window fill (D+2) gets 20 holding days: horizon exit on the 20th bar counting the fill day as day 1');
  ok(res.terminal && res.delta === 0 && r.twins.L.exits[0].reason === 'horizon', 'horizon: both twins close at the day-20 close');
  var cut = adj(e2, 12, { candles: cs.slice(0, 11) }).pair;
  ok(cut.position.hDone === 10 && cut.twins.T.exits.length === 0 && P1.statusOf(cut) === 'open', 'horizon isolation: the P1 position does not exit at the cohort HORIZON_BAR (10)');
})();
(function () {   // trades on the fill day (partial bar after a crossing-ask fill): order of prints decides; rung before stop in time
  var plan1 = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)]), fibs([104, 106, 108, 112, 116]), geo(), C), c = cap(0);
  var P = pairWith(plan1, { quote: quote(c.issueSec + 5, 99.9), cap: c }), ts = P.submission.submittedAtSec, b0 = Math.floor(ts / BAR5) * BAR5;
  var bars = [bar5(b0, 100, 104.6, 94.5, 95)].concat(flat5(b0 + BAR5, D0 + DAY, 95));
  var r = adj(P, 1, { bars5: bars });
  ok(r.pair.position.unresolved && r.pair.position.unresolved.reason === 'trades-pending' && r.needs.some(function (n) { return n.kind === 'trades' && n.fromSec === ts && n.toSec === b0 + BAR5; }), 'fill-day partial bar touching S and a rung -> covered Trades required');
  var sl = { fromSec: ts, toSec: b0 + BAR5, complete: true, trades: [{ t: ts + 20, p: 104.2, n: 1 }, { t: ts + 40, p: 94.9, n: 2 }] };
  var r2 = adj(P, 1, { bars5: bars, trades: [sl] }).pair;
  eq(r2.twins.L.exits.map(function (x) { return [x.reason, x.price, x.lots, x.tSec]; }), [['rung', 104, 22, ts + 20], ['stop', 95, 23, ts + 40]], 'Trades ordering: the rung print precedes the stop print -> rung then stop on the remaining');
  eq(r2.twins.T.exits.map(function (x) { return [x.reason, x.price, x.tSec]; }), [['stop', 95, ts + 40]], 'the T twin stops on the later print (no rung)');
  ok(r2.twins.L.exits.every(function (x) { return x.interval === null; }) && r2.twins.T.exits[0].interval === null, 'exact print times recorded when Trades decide');
  var r3 = adj(filledPair(tOnly(), 101), 2, { candles: [daily(D0 + DAY, 101, 121, 100.5, 119)] }).pair;
  eq(r3.twins.T.exits[0].interval, [D0 + DAY, D0 + 2 * DAY], 'bar interval recorded when the exact execution time is unknown');
})();

// ---------- 52v B1: opening gaps are known events and come before the stop / conflict convention (Astra Freeze Record Review 2026-10-18) ----------
(function () {
  // Astra's case: S 95 / L 100 / T 120 / tick 0.01 / Q 45, one half-size rung at 110 (zone Mlo 4 -> fraction tier, 22 lots), an open position; fixtures assert full pair P&L and delta, not only labels.
  var plan = P1.ladderPlan(zonesOf([zone('a', 109.5, 110.5, 4)]), fibs([110, 125, 130, 135, 140]), geo(), C), d1 = D0 + DAY;
  eq(plan.rungs.map(function (r) { return [r.price, r.tier, r.lots]; }), [[110, 'fraction', 22]], 'setup B1: one half rung at 110 (22 of 45 lots)');
  function legs(P, tw) { return P.twins[tw].exits.map(function (x) { return [x.reason, x.price, x.lots, x.adverse]; }); }
  function pnlOf(P, tw) { return P1.pairResult(P)['netPnL_' + tw]; }
  function expectPnl(P, exits) {   // independent of twinBar: entry costs from the recorded fill, each exit leg priced by OrdersCore's own rounding
    var f = P.entry.fill, g = P.geometry, s = -(f.notionalCents + f.feeCents + f.frictionCents);
    exits.forEach(function (x) { var n = OC.notional(x.lots, g.lotsInv, x.price), c = OC.sideCharges(n, x.kind, x.adverse, 'base'); s += n - c.feeCents - c.frictionCents; });
    return s;
  }
  var A = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 121, 122, 94, 100)] }).pair, rA = P1.pairResult(A);
  eq(legs(A, 'T'), [['gap-target', 121, 45, false]], 'FIXTURE B1 gap-through-rung-and-T: T twin exits all 45 at the 121 open (gap-target)');
  eq(legs(A, 'L'), [['gap-target', 121, 45, false]], 'FIXTURE B1 gap-through-rung-and-T: L twin exits all 45 at the 121 open as ONE gap-target (every resting order traded through at the open; no rung record, so the ladder did not change the outcome)');
  ok(pnlOf(A, 'L') === pnlOf(A, 'T') && pnlOf(A, 'T') === expectPnl(A, [{ price: 121, lots: 45, kind: 'maker', adverse: false }]) && rA.delta === 0 && rA.flags.affected === false && rA.terminal, 'FIXTURE B1 gap-through-rung-and-T: identical P&L, delta 0, affected false, terminal (was T +3.93 R / L -1.33 R conflict-stop)', { T: pnlOf(A, 'T'), L: pnlOf(A, 'L'), delta: rA.delta });
  var c0 = cap(0), A2 = pairWith(plan, { quote: quote(c0.issueSec + 5, 100) });   // Astra's figures assume the fresh-ask (taker, adverse) entry at 100
  ok(A2.entry.fill && A2.entry.fill.reason === 'fill-crossing-ask', 'setup B1: pair filled at the crossing ask (100)');
  A2 = adj(A2, 2, { bars5: flat5(A2.submission.submittedAtSec, D0 + DAY, 101), candles: [daily(d1, 121, 122, 94, 100)] }).pair; var rA2 = P1.pairResult(A2);
  ok(Math.abs(rA2.R_T - 3.93316) < 5e-4 && rA2.R_L === rA2.R_T && rA2.delta === 0 && legs(A2, 'L')[0][0] === 'gap-target', 'FIXTURE B1 gap-through-rung-and-T (Astra\'s numbers): T +3.93316 R and L identical (was L -1.33151 R, delta -5.26467 R)', { R_T: rA2.R_T, R_L: rA2.R_L });
  var B = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 111, 122, 94, 100)] }).pair, rB = P1.pairResult(B);
  eq(legs(B, 'L'), [['gap-rung', 111, 22, false], ['conflict-stop', 95, 23, true]], 'FIXTURE B1 gap-above-rung-then-stop (O111/H122/L94): L gap-rung half at 111, remainder conflict-stop at 95');
  eq(legs(B, 'T'), [['conflict-stop', 95, 45, true]], 'FIXTURE B1 gap-above-rung-then-stop: T conflict-stop all at 95');
  ok(pnlOf(B, 'L') === expectPnl(B, [{ price: 111, lots: 22, kind: 'maker', adverse: false }, { price: 95, lots: 23, kind: 'taker', adverse: true }]) && pnlOf(B, 'T') === expectPnl(B, [{ price: 95, lots: 45, kind: 'taker', adverse: true }]) && rB.delta > 0 && rB.flags.affected === true && rB.terminal, 'FIXTURE B1 gap-above-rung-then-stop: full P&L per leg, delta > 0, affected true', { T: pnlOf(B, 'T'), L: pnlOf(B, 'L'), delta: rB.delta });
  var Cc = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 111, 122, 100, 100)] }).pair, rC = P1.pairResult(Cc);
  eq(legs(Cc, 'L'), [['gap-rung', 111, 22, false], ['target', 120, 23, false]], 'FIXTURE B1 gap-above-rung-no-stop (O111/H122/L100): L gap-rung half at 111 then target at 120');
  eq(legs(Cc, 'T'), [['target', 120, 45, false]], 'FIXTURE B1 gap-above-rung-no-stop: T target at 120');
  ok(pnlOf(Cc, 'L') === expectPnl(Cc, [{ price: 111, lots: 22, kind: 'maker', adverse: false }, { price: 120, lots: 23, kind: 'maker', adverse: false }]) && pnlOf(Cc, 'T') === expectPnl(Cc, [{ price: 120, lots: 45, kind: 'maker', adverse: false }]) && rC.delta < 0 && rC.flags.affected === true, 'FIXTURE B1 gap-above-rung-no-stop: full P&L per leg; the half rung below T costs the ladder (delta < 0)', { delta: rC.delta });
  var Dd = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 121, 122, 100, 100)] }).pair, rD = P1.pairResult(Dd);
  eq([legs(Dd, 'T'), legs(Dd, 'L')], [[['gap-target', 121, 45, false]], [['gap-target', 121, 45, false]]], 'FIXTURE B1 gap-above-T-no-later-stop (O121/H122/L100): both twins gap-target all at 121');
  ok(rD.delta === 0 && rD.flags.affected === false && rD.terminal, 'FIXTURE B1 gap-above-T-no-later-stop: delta 0, affected false');
  var E = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 111, 115, 100, 112)] }).pair;
  eq([legs(E, 'L'), legs(E, 'T'), E.twins.L.remainingLots, E.twins.L.closed, P1.statusOf(E)], [[['gap-rung', 111, 22, false]], [], 23, false, 'open'], 'FIXTURE B1 gap-above-partial-rung-only (O111/H115/L100, no stop): L fills the half rung at the open and stays open with 23 lots; T has no event');
  var F = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 111, 115, 94, 100)] }).pair, rF = P1.pairResult(F);
  eq(legs(F, 'L'), [['gap-rung', 111, 22, false], ['stop', 95, 23, false]], 'FIXTURE B1 gap-above-partial-rung-then-stop (O111/H115/L94): L gap-rung half at 111, remainder plain stop at 95 (no rung / T reachable after the open -> not a conflict)');
  eq(legs(F, 'T'), [['stop', 95, 45, false]], 'FIXTURE B1 gap-above-partial-rung-then-stop: T plain stop at 95 (exitRules)');
  ok(pnlOf(F, 'L') === expectPnl(F, [{ price: 111, lots: 22, kind: 'maker', adverse: false }, { price: 95, lots: 23, kind: 'taker', adverse: false }]) && rF.delta > 0 && rF.flags.affected, 'FIXTURE B1 gap-above-partial-rung-then-stop: full P&L, delta > 0', { delta: rF.delta });
  var G = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 101, 122, 94, 100)] }).pair;
  eq([legs(G, 'L'), legs(G, 'T')], [[['conflict-stop', 95, 45, true]], [['conflict-stop', 95, 45, true]]], 'B1 unchanged: open inside (101), stop and rung / T both reachable intrabar -> stop-first conflict on both twins (unknown intrabar order)');
  var H = adj(filledPair(plan, 101), 2, { candles: [daily(d1, 94.5, 122, 94, 100)] }).pair;
  eq([legs(H, 'L'), legs(H, 'T')], [[['gap-stop', 94.5, 45, true]], [['gap-stop', 94.5, 45, true]]], 'B1 unchanged: open at/below S -> gap-stop first on both twins');
  var two = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4), zone('b', 105.8, 106.2, 4)]), fibs([104, 106, 108, 112, 116]), geo(), C);
  eq(two.rungs.map(function (r) { return [r.price, r.lots]; }), [[104, 22], [106, 11]], 'setup B1: two fraction rungs (104: 22 lots, 106: 11 lots)');
  var I = adj(filledPair(two, 101), 2, { candles: [daily(d1, 106.5, 107, 94, 100)] }).pair;
  eq(legs(I, 'L'), [['gap-rung', 106.5, 22, false], ['gap-rung', 106.5, 11, false], ['stop', 95, 12, false]], 'B1: an open above two rungs fills both at the open, ascending, then the remainder follows the stop convention');
  var J = adj(filledPair(two, 101), 2, { candles: [daily(d1, 104.5, 107, 94, 100)] }).pair;
  eq(legs(J, 'L'), [['gap-rung', 104.5, 22, false], ['conflict-stop', 95, 23, true]], 'B1: open above the first rung only; the second rung was reachable intrabar with the stop -> conflict-stop on the remainder (stop first)');
})();

// ---------- 52v B2: the rung net-positive test carries the permitted entry charge (taker + adverse friction, 85 bp) and the maker exit (40 bp), cents per leg on the allocated lots ----------
(function () {
  var g = geo(), lv = function (r) { return fibs([r, 130, 131, 132, 133]); }, nnp = function (p) { return p.rejected.filter(function (r) { return r.reason === 'not-net-positive'; }); };
  eq([P1.rungNet(100, 100.9, 45, 1, C).netCents, P1.rungNet(100, 100.9, 45, 1, C).entryChargeBp, P1.rungNet(100, 100.9, 45, 1, C).exitChargeBp], [-1591, 85, 40], 'B2: rungNet reproduces Astra\'s -$15.91 round trip (45 units, L 100, rung 100.90, 85 bp in / 40 bp out, cent rounding)');
  var x = P1.ladderPlan(zonesOf([zone('a', 100.5, 101.2, 10)]), lv(100.9), g, C);
  ok(x.tOnly && x.rungs.length === 0 && nnp(x).length === 1 && nnp(x)[0].detail.netCents === -1591 && nnp(x)[0].detail.lots === 45 && nnp(x)[0].zoneId === 'a' && x.fallbackReason === 'no-confluence', 'FIXTURE B2 crossing-ask counterexample: pass zone Mlo 10 coincident with a fib rung at 100.90 -> rung REJECTED not-net-positive (-1591 cents on 45 units); the plan is T-only', nnp(x));
  ok((100.9 - 100 - (100.9 + 100) * 0.004) > 0, 'FIXTURE B2 crossing-ask counterexample: the superseded 40 bp / 40 bp per-unit test would have accepted it (+$0.0964 per unit)');
  var y = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)]), fibs([104, 106, 108, 112, 116]), g, C);
  eq(y.rungs.map(function (r) { return [r.price, r.lots, r.netCents, r.netTest.entryChargeBp, r.netTest.exitChargeBp]; }), [[104, 22, P1.rungNet(100, 104, 22, 1, C).netCents, 85, 40]], 'FIXTURE B2 ordinary resting-fill: a rung 4 % above L is accepted; netCents recorded on its 22 allocated lots with 85 / 40 bp');
  ok(y.rungs[0].netCents > 0 && y.rungs[0].netPerUnit > 0 && y.inputs.entryChargeBp === 85 && y.inputs.exitChargeBp === 40, 'FIXTURE B2 ordinary resting-fill: positive net; plan inputs record both charge rates');
  var lo = P1.ladderPlan(zonesOf([zone('a', 100.8, 101.7, 10)]), lv(101.25), g, C), hi = P1.ladderPlan(zonesOf([zone('a', 100.8, 101.7, 10)]), lv(101.26), g, C);
  ok(lo.tOnly && nnp(lo).length === 1 && nnp(lo)[0].detail.netCents === -23, 'FIXTURE B2 boundary below: rung 101.25 (all-out, 45 units) -> -23 cents -> rejected');
  ok(hi.rungs.length === 1 && hi.rungs[0].price === 101.26 && hi.rungs[0].netCents === 22, 'FIXTURE B2 boundary just above: rung 101.26 -> +22 cents -> accepted');
  ok((101.25 - 100 - (101.25 + 100) * 0.004) > 0, 'FIXTURE B2 boundary: the superseded test accepted 101.25 too');
  var fr = P1.ladderPlan(zonesOf([zone('a', 100.8, 101.7, 4)]), lv(101.25), g, C), fr2 = P1.ladderPlan(zonesOf([zone('a', 100.8, 101.7, 4)]), lv(101.26), g, C);
  ok(fr.tOnly && nnp(fr)[0].detail.lots === 22 && nnp(fr)[0].detail.netCents === -11 && fr2.rungs.length === 1 && fr2.rungs[0].lots === 22 && fr2.rungs[0].netCents === 11, 'B2: the test runs on the lots the tier allocates (fraction: 22 units) with the same rounding convention');
  var free = P1.ladderPlan(zonesOf([zone('wide', 100.5, 104.5, 4)]), fibs([100.9, 104, 130, 131, 132]), g, C);
  ok(free.rungs.length === 1 && free.rungs[0].price === 104 && free.rungs[0].zoneId === 'wide' && nnp(free).length === 1, 'B2: a zone whose first coincident level fails the net test is NOT consumed; it carries the next (net-positive) level');
  var aa = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4)]), fibs([104, 106, 108, 112, 116]), g, cfg({ costScenario: 'allAdverse' }));
  ok(aa.inputs.entryChargeBp === 85 && aa.inputs.exitChargeBp === 85 && aa.rungs.length === 1 && aa.rungs[0].netCents === P1.rungNet(100, 104, 22, 1, cfg({ costScenario: 'allAdverse' })).netCents && aa.rungs[0].netCents < y.rungs[0].netCents, "B2: under 'allAdverse' both legs carry 85 bp (declared scenario, not hard-coded 40)");
  var ne = P1.ladderPlan(zonesOf([zone('a', 99.5, 100.6, 20), zone('b', 119.5, 120.5, 20)]), fibs([100.2, 120, 108, 112, 116]), g, C);
  ok(ne.rejected.some(function (r) { return r.reason === 'not-net-positive'; }) && ne.rejected.some(function (r) { return r.reason === 'at-or-above-target'; }), 'B2: the 52s not-net-positive fixture still rejects under the stricter test');
})();

// ---------- controller (B2) ----------
(function () {
  var plan = P1.ladderPlan(zonesOf([zone('a', 103.5, 104.5, 4), zone('b', 105.8, 106.2, 12)]), fibs([104, 106, 108, 112, 116]), geo(), C);
  var A = filledPair(plan, 101), st = P1.controllerAfterPair(A);
  eq(P1.rearm(st, { price: 99.5, activePair: P1.isActive(A), captureId: 'c1' }, C).allow, false, 'controller: an open pair blocks a new pair for the coin');
  var rc = adj(A, 2, { candles: [daily(D0 + DAY, 101, 106.5, 100.8, 105)] }).pair;   // L all-out, T open
  var r1 = P1.rearm(st, { price: 99.5, activePair: P1.isActive(rc), captureId: 'c2' }, C);
  ok(r1.allow === false && r1.reason === 'active-pair', 'FIXTURE early-L all-out then late-T open -> no re-arm while T is open');
  var rt = adj(rc, 3, { candles: [daily(D0 + DAY, 101, 106.5, 100.8, 105), daily(D0 + 2 * DAY, 105, 121, 104, 119)] }).pair;   // T exits
  ok(P1.statusOf(rt) === 'terminal' && P1.isActive(rt) === false, 'both twins terminal');
  var r2 = P1.rearm(st, { price: 99.5, activePair: false, captureId: 'c3' }, C);
  ok(r2.allow === false && r2.reason === 'awaiting-departure' && r2.state.departed === false, 'controller: both terminal but the price is still inside the frozen zone + envelope -> awaiting departure');
  var r3 = P1.rearm(r2.state, { price: 104, activePair: false, captureId: 'c4' }, C);
  ok(r3.allow === false && r3.reason === 'departure-observed' && r3.state.departed === true, 'controller: a capture price outside the frozen envelope is the departure (sampled at capture time)');
  var r4 = P1.rearm(r3.state, { price: 103, activePair: false, captureId: 'c5' }, C);
  ok(r4.allow === false && r4.reason === 'awaiting-return', 'controller: still outside -> awaiting return');
  var r5 = P1.rearm(r4.state, { price: 101.5, activePair: false, captureId: 'c6' }, C);
  ok(r5.allow === true && r5.reason === 'returned', 'controller: a capture price back inside the frozen zone + envelope re-arms');
  var pend = pairWith(tOnly()), sp = P1.controllerAfterPair(pend);
  ok(P1.rearm(sp, { price: 99.5, activePair: P1.isActive(pend) }, C).reason === 'active-pair', 'controller: a resting (pending) pair blocks a duplicate on a repeated capture');
  var rej = pairWith(tOnly(), { quote: quote(cap(0).issueSec + 5, 94) }), sr = P1.controllerAfterPair(rej);
  ok(rej.entry.status === 'rejected-invalid-at-submission', 'setup: ask <= S rejected at submission');
  ok(P1.isActive(rej) === false && P1.rearm(sr, { price: 99.5, activePair: false }, C).reason === 'awaiting-departure', 'controller: a rejected pair re-arms by the same departure / return rule');
  ok(P1.rearm(null, { price: 99.5, activePair: false }, C).allow === true, 'controller: no prior pair -> allowed');
})();

// ---------- 52v B3 through the actual wrapper: capture.js fwdP1Step in a vm, isolated files, deterministic I/O ----------
(function () {
  var fs = require('fs'), os = require('os'), vm = require('vm'), crypto = require('crypto');
  if (!fs.existsSync(CAPTURE_PATH)) { ok(false, 'FIXTURE B3 wrapper: capture.js not found at ' + CAPTURE_PATH + ' (pass it as argv[6])'); return; }
  var SZ_PATH = path.join(root, 'radar_tools', 'book', 'sellzone-core.js'), BC_PATH = path.join(root, 'radar_tools', 'book', 'book-codec.js'), BK_PATH = path.join(root, 'radar_tools', 'book', 'book-core.js'), CC_PATH = path.join(root, 'channel-core.js');
  var SZ = require(SZ_PATH), BC = require(BC_PATH), sha = function (f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); };
  var logs = { out: [], err: [] }, stubs = { './universe-core.js': {}, './channel-core.js': {}, './cache-core.js': {}, './setups-core.js': {}, './exchange-map.js': {}, './exchange-ohlcv.js': {}, './episodes-core.js': EC, './orders-core.js': OC, fs: fs, path: path, crypto: crypto, child_process: {}, zlib: require('zlib') };
  var resolveMap = { './p1-core.js': P1_PATH, './orders-core.js': OC_PATH, './episodes-core.js': EC_PATH, './channel-core.js': CC_PATH, './radar_tools/book/book-core.js': BK_PATH, './radar_tools/book/book-codec.js': BC_PATH, './radar_tools/book/sellzone-core.js': SZ_PATH, './radar_tools/zones/fib-core.js': FIB_PATH };
  function rq(n) { return n in stubs ? stubs[n] : require(n); } rq.resolve = function (n) { return resolveMap[n] || require.resolve(n); };
  var src = fs.readFileSync(CAPTURE_PATH, 'utf8').replace(/\nmain\(\)\.catch\([^\n]*\n?$/, '\nglobalThis.__p1 = { fwdP1Step: fwdP1Step };\n');
  if (!/__p1 = /.test(src)) { ok(false, 'FIXTURE B3 wrapper: could not neutralise main() in capture.js'); return; }
  var cx = vm.createContext({ require: rq, process: { env: { CG_KEY: 'fixture' }, pid: 1, argv: [], exitCode: undefined, exit: function (c) { throw new Error('exit ' + c); } }, console: { log: function () { logs.out.push(Array.prototype.join.call(arguments, ' ')); }, warn: function () {}, error: function () { logs.err.push(Array.prototype.join.call(arguments, ' ')); } },
    fetch: function () { return Promise.reject(new Error('offline')); }, __dirname: root, Buffer: Buffer, setTimeout: setTimeout, Date: Date, JSON: JSON, Math: Math, Set: Set, Map: Map, Promise: Promise, Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp, Error: Error, isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat });
  vm.runInContext(src, cx, { filename: 'capture.js' });
  var step = cx.__p1.fwdP1Step, d = { fs: fs, path: path, crypto: crypto };
  var dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-52v-')), p1dir = path.join(dataRoot, 'forward', 'p1');
  fs.mkdirSync(p1dir, { recursive: true }); fs.mkdirSync(path.join(dataRoot, 'book'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'book', 'sellzone-params.json'), JSON.stringify({ status: 'frozen', clustering: { name: 'x' }, cutoffs: { concentration: 1, material: 1 }, staleMultiplier: 2 }));
  var pinned = { capture: null, analysis: null, p1Core: sha(P1_PATH), ordersCore: sha(OC_PATH), episodesCore: sha(EC_PATH), channelCore: sha(CC_PATH), bookCore: sha(BK_PATH), bookCodec: sha(BC_PATH), sellzoneCore: sha(SZ_PATH), fibCore: sha(FIB_PATH), sellzoneParams: sha(path.join(dataRoot, 'book', 'sellzone-params.json')) };
  var CFGF = Object.assign({ arm: 'P1' }, cfg({ status: 'frozen', frozenAt: '2026-10-20T00:00:00.000Z', pinned: pinned }));
  function writeCfg(c) { fs.writeFileSync(path.join(p1dir, 'p1-config.json'), JSON.stringify(c)); }
  function snapshot() { var m = {}; (function walk(dir, rel) { fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) { var f = path.join(dir, e.name), r = rel + '/' + e.name; if (e.isDirectory()) walk(f, r); else m[r] = sha(f); }); })(dataRoot, 'data'); return m; }
  function captureOn(date, cgs) {   // one canonical capture dated `date` (issue 00:29Z) with one eligible research row per cg (all gates pass, price 100 in zone [99, 100], S 95 / L 100 / T 120)
    var t0 = Date.parse(date + 'T00:00:00.000Z') / 1000, iss = t0 + 29 * 60, research = {}, coins = {};
    cgs.forEach(function (cg) { research[cg] = row(); coins[cg] = { pair: 'XUSD', venueEligible: true, meta: META, candles: [], quote: null }; });
    var capture = { captureId: 'cap-' + date, generationId: 'g-' + date, date: date, issueTimeUtc: new Date(iss * 1000).toISOString(), issueSec: iss, inputCutoffSec: t0, protocolVersion: 'test' };
    var io = { modules: { P1: P1, SZ: SZ, BC: BC, FIB: FIB }, now: function () { return iss * 1000 + 5000; }, sleep: function () { return Promise.resolve(); }, fetchKrakenDaily: function () { return Promise.resolve([]); }, fetchBuffer: function () { return Promise.resolve(null); }, bookBase: 'stub://',
      fetchJson: function (u) { if (/cadence\.json$/.test(u)) return Promise.resolve({ version: 'stub', table: [] }); if (/AssetPairs/.test(u)) return Promise.resolve({ error: [], result: {} }); if (/Ticker/.test(u)) return Promise.resolve({ error: [], result: { XXUSD: { c: ['100.5', '1'], a: ['100.5', '1', '1'], b: ['100.4', '1', '1'] } } }); return Promise.reject(new Error('offline')); } };
    return step(d, dataRoot, capture, { research: research, coins: coins, ev: {}, assetPairs: { XUSD: { key: 'XXUSD' } } }, io);
  }
  function readGen(date) { return JSON.parse(fs.readFileSync(path.join(p1dir, 'gen-g-' + date, 'pairs.json'), 'utf8')); }
  function readOpps(date) { return JSON.parse(fs.readFileSync(path.join(p1dir, 'gen-g-' + date, 'opportunities.json'), 'utf8')); }
  function current() { return JSON.parse(fs.readFileSync(path.join(p1dir, 'CURRENT.json'), 'utf8')); }
  var pending = [];
  function run(fn) { pending.push(fn); }
  writeCfg(CFGF);
  var all = ['c1', 'c2', 'c3', 'c4', 'c5'];
  (async function () {
    var r1 = await captureOn('2026-10-19', ['c1']); if (r1.status !== 'ok') { ok(false, 'B3 wrapper first capture', { r1: r1, err: logs.err.slice(-3) }); return finish(); } var g1 = readGen('2026-10-19');
    ok(r1.status === 'ok' && r1.counts.pairsCreated === 1 && g1.phase === 'pre-freeze' && g1.pairs[0].study === false && g1.pairs[0].pairId === 'P1-2026-10-19-c1' && current().calendar === null, 'FIXTURE B3 window: capture one day before issuanceStart (frozen, before frozenAt) issues a development pair, study:false, no calendar yet', { r1: r1.status, counts: r1.counts, phase: g1.phase });
    var r2 = await captureOn('2026-10-20', ['c1', 'c2']), g2 = readGen('2026-10-20'), o2 = readOpps('2026-10-20'), cur2 = current();
    ok(r2.status === 'ok' && g2.phase === 'study-issuance' && cur2.calendar && cur2.calendar.anchor === '2026-10-20' && cur2.calendar.issuanceEndExclusive === '2026-12-19T00:00:00.000Z' && g2.calendar.anchor === '2026-10-20', 'FIXTURE B3 window: the first capture at/after frozenAt anchors the calendar (10-20 -> issuance end Dec 19 exclusive) and persists it in CURRENT + the generation meta', { status: r2.status, cur: cur2.calendar, phase: g2.phase });
    var p2 = g2.pairs.filter(function (p) { return p.cgId === 'c2'; })[0], p1b = g2.pairs.filter(function (p) { return p.cgId === 'c1'; })[0], oc1 = o2.opportunities.filter(function (o) { return o.cgId === 'c1'; })[0];
    ok(p2 && p2.study === true && p2.phase === 'study-issuance' && p1b && p1b.study === false && r2.counts.studyPairsCreated === 1, 'FIXTURE B3 window: on issuanceStart the new pair is study:true; the pre-freeze pair keeps study:false', { p2: p2 && p2.study, p1: p1b && p1b.study });
    ok(oc1 && oc1.outcome === 'controller-blocked' && oc1.controller.blockedBy === 'development-pair' && r2.counts.blockedByDevelopmentPair === 1, 'FIXTURE B3 development-pair disclosure: the still-active development pair blocks the coin and is disclosed as blockedBy: development-pair (not relabeled, not reset)', oc1 && oc1.controller);
    var r3 = await captureOn('2026-12-18', all.slice(0, 3)), g3 = readGen('2026-12-18'), p3 = g3.pairs.filter(function (p) { return p.cgId === 'c3'; })[0];
    ok(r3.status === 'ok' && g3.phase === 'study-issuance' && p3 && p3.study === true && r3.counts.pairsCreated === 1 && current().calendar.anchor === '2026-10-20', 'FIXTURE B3 window: the last issuance day (Dec 18) still issues study pairs from the persisted calendar', { status: r3.status, counts: r3.counts });
    var r4 = await captureOn('2026-12-19', all.slice(0, 4)), g4 = readGen('2026-12-19'), o4 = readOpps('2026-12-19'), oc4 = o4.opportunities.filter(function (o) { return o.cgId === 'c4'; })[0];
    ok(r4.status === 'ok' && g4.phase === 'post-issuance' && r4.counts.pairsCreated === 0 && r4.counts.outsideIssuanceWindow === 1 && oc4.outcome === 'outside-issuance-window' && oc4.eligible === true && g4.pairs.length === 3, 'FIXTURE B3 window: issuanceEndExclusive (Dec 19) issues nothing; the eligible opportunity is recorded outside-issuance-window; the three pairs are still carried (adjudication continues)', { status: r4.status, counts: r4.counts, phase: g4.phase });
    var r5 = await captureOn('2026-12-20', all), g5 = readGen('2026-12-20');
    ok(r5.status === 'ok' && g5.phase === 'post-issuance' && r5.counts.pairsCreated === 0 && g5.pairs.length === 3 && g5.pairs.every(function (p) { return p.study === (p.cgId !== 'c1'); }), 'FIXTURE B3 window: one day after the window issues nothing; study labels unchanged (c1 false, c2 / c3 true)', { status: r5.status, counts: r5.counts });
    ok(g5.pairs.every(function (p) { return p.entry.status === 'resting' || p.entry.status === 'pending-unresolved'; }), 'setup: the pairs rest (ask 100.5 > L) - evidence fetches are offline in this fixture');
    // identity mismatch -> held
    var before = snapshot(), curBefore = current();
    writeCfg(Object.assign({}, CFGF, { pinned: Object.assign({}, pinned, { p1Core: 'f'.repeat(64) }) }));
    var r6 = await captureOn('2026-12-21', all), after = snapshot(), curAfter = current();
    var changed = Object.keys(after).filter(function (k) { return before[k] !== after[k]; }).concat(Object.keys(before).filter(function (k) { return !(k in after); }));
    ok(r6.status === 'held' && r6.reason === 'identity-mismatch' && r6.mismatches.length === 1 && r6.mismatches[0].key === 'p1Core', 'FIXTURE B3 identity mismatch -> held (p1-core.js hash differs from pinned)', r6);
    ok(fs.existsSync(path.join(p1dir, 'gen-g-2026-12-21', 'held.json')) && !fs.existsSync(path.join(p1dir, 'gen-g-2026-12-21', 'pairs.json')) && JSON.parse(fs.readFileSync(path.join(p1dir, 'gen-g-2026-12-21', 'held.json'), 'utf8')).held === 'identity-mismatch', 'FIXTURE B3 identity mismatch: a held record is written, no pairs / ledgers for that generation');
    ok(changed.every(function (k) { return k.indexOf('data/forward/p1/') === 0; }) && changed.length === 3 && changed.indexOf('data/forward/p1/CURRENT.json') >= 0 && changed.indexOf('data/forward/p1/gen-g-2026-12-21/held.json') >= 0 && changed.indexOf('data/forward/p1/p1-config.json') >= 0, 'FIXTURE B3 identity mismatch: zero writes outside data/forward/p1/ (only the held record, CURRENT.held and the tampered config changed)', changed);
    ok(curAfter.generationId === curBefore.generationId && curAfter.held && curAfter.held.reason === 'identity-mismatch' && curAfter.held.generationId === 'g-2026-12-21' && JSON.stringify(curAfter.calendar) === JSON.stringify(curBefore.calendar), 'FIXTURE B3 identity mismatch: CURRENT keeps its generation pointer and calendar; only a held marker is added', curAfter.held);
    ok(logs.err.some(function (l) { return /^p1: HELD identity-mismatch/.test(l); }), 'FIXTURE B3 identity mismatch: logged as p1: HELD identity-mismatch');
    writeCfg(CFGF);
    var r7 = await captureOn('2026-12-22', all), g7 = readGen('2026-12-22');
    ok(r7.status === 'ok' && g7.pairs.length === 3 && g7.phase === 'post-issuance' && r7.counts.pairsCreated === 0, 'FIXTURE B3 identity restored: the next capture resumes from the retained pair list (3 pairs), still outside the window', { status: r7.status, counts: r7.counts });
    // config-level rejections through the wrapper
    writeCfg(Object.assign({}, CFGF, { pinned: {} }));
    var r8 = await captureOn('2026-12-23', all);
    ok(r8.status === 'config-error' && r8.errors.length === 9 && logs.err.some(function (l) { return /CONFIGURATION ERROR.*pinned\.p1Core/.test(l); }), 'FIXTURE B3 empty pinned with status frozen -> config rejected by the wrapper (P1 step skipped)', r8);
    writeCfg(Object.assign({}, CFGF, { calendar: Object.assign({}, current().calendar, { anchor: '2026-10-21', issuanceStart: '2026-10-21T00:00:00.000Z' }) }));
    var r9 = await captureOn('2026-12-23', all);
    ok(r9.status === 'config-error', 'B3: a config calendar that is not the derived one is rejected', r9);
    writeCfg(CFGF);
    // Astra's reproduction, isolated: frozenAt 10-20, captures dated 10-19 and 12-19 must not issue study:true pairs - covered above (10-19 -> study:false; 12-19 -> nothing). Count them explicitly:
    var studyIssued = {}; ['2026-10-19', '2026-10-20', '2026-12-18', '2026-12-19', '2026-12-20'].forEach(function (dt) { var g = readGen(dt); studyIssued[dt] = g.pairs.filter(function (p) { return p.issueDate === dt && p.study === true; }).length; });
    eq(studyIssued, { '2026-10-19': 0, '2026-10-20': 1, '2026-12-18': 1, '2026-12-19': 0, '2026-12-20': 0 }, 'FIXTURE B3 window summary: study issuance on 10-20 and 12-18 only (Astra\'s 10-19 / 12-19 reproduction now issues no study pair)');
    ok(OC.CFG.HORIZON_BAR === 10 && JSON.stringify(OC.CFG) === CFG_BEFORE, 'wrapper fixtures: OrdersCore.CFG unchanged after the real fwdP1Step runs');
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch (e) {}
    finish();
  })().catch(function (e) { ok(false, 'FIXTURE B3 wrapper threw', String(e && e.stack || e)); finish(); });
  WRAPPER_ASYNC = true;
})();

// ---------- horizon isolation (runs after the async wrapper fixtures finish) ----------
function finish() {
  ok(OC.CFG.HORIZON_BAR === 10 && OC.CFG.RETAIN_BARS === 20 && JSON.stringify(OC.CFG) === CFG_BEFORE, 'FIXTURE horizon isolation: OrdersCore.CFG unchanged (HORIZON_BAR 10, RETAIN_BARS 20) after every P1 call');
  ok(C.horizonHoldingDays === 20, 'the P1 horizon (20) lives in p1-config, not in OrdersCore.CFG');
  console.log('p1-core tests: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
if (!WRAPPER_ASYNC) finish();
