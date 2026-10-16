/* radar_tools/p1-core.test.js — item 52s acceptance B: p1-core.js (P1 Practitioner arm) fixtures. Node only, deterministic, no network, no clock.
 * Run: node radar_tools/p1-core.test.js [p1-core.js] [orders-core.js] [fib-core.js] [episodes-core.js]   -> "p1-core tests: n passed, m failed". Exit 1 on any failure.
 * Required fixtures (IMP 52s §5): all-16-gates (five retained pass, ten omitted fail -> eligible); width-fail not filtered by a hidden screen; invalidation 95 vs stop 99 -> S = 95 rounded up; same marks / different excursions;
 * multi-rung + stop conflict in one bar (stop first); early-L all-out then late-T open -> no re-arm until both terminal; duplicate zone across three fib levels -> one rung; unavailable / bounded M -> no tier;
 * stale zone excluded before slot consumption; zero-lot partial -> not a rung; causal fib confirmation; unresolved twin -> pair unresolved; last-window fill through D+2 gets 20 holding days; horizon isolation (OrdersCore.CFG.HORIZON_BAR = 10). */
'use strict';
var path = require('path');
var here = __dirname, root = path.resolve(here, '..');
var P1 = require(path.resolve(process.argv[2] || path.join(root, 'p1-core.js')));
var OC = require(path.resolve(process.argv[3] || path.join(root, 'orders-core.js')));
var FIB = null; try { FIB = require(path.resolve(process.argv[4] || path.join(root, 'radar_tools', 'zones', 'fib-core.js'))); } catch (e) { FIB = null; }
var EC = null; try { EC = require(path.resolve(process.argv[5] || path.join(root, 'episodes-core.js'))); } catch (e) { EC = null; }
var CFG_BEFORE = JSON.stringify(OC.CFG);
var pass = 0, fail = 0;
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
ok(P1.validateConfig(cfg({ expiry: 'end-D+3' })).length === 1 && P1.validateConfig(cfg({ costScenario: 'none' })).length === 1 && P1.validateConfig(cfg({ X_low: 11 })).length === 1 && P1.validateConfig(cfg({ status: 'frozen' })).length === 1, 'config: expiry, cost scenario, X_low <= X_high and frozen-without-frozenAt are rejected');
ok(P1.isStudy(C) === false && P1.isStudy(cfg({ status: 'frozen', frozenAt: '2026-11-01T00:00:00.000Z' })) === true, 'config: unfrozen -> study false; frozen -> study true');
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

// ---------- horizon isolation ----------
ok(OC.CFG.HORIZON_BAR === 10 && OC.CFG.RETAIN_BARS === 20 && JSON.stringify(OC.CFG) === CFG_BEFORE, 'FIXTURE horizon isolation: OrdersCore.CFG unchanged (HORIZON_BAR 10, RETAIN_BARS 20) after every P1 call');
ok(C.horizonHoldingDays === 20, 'the P1 horizon (20) lives in p1-config, not in OrdersCore.CFG');

console.log('p1-core tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
