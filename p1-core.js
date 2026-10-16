/* p1-core.js — P1 Practitioner arm (item 52s): paired-exit study on a shared opportunity stream. Pure functions (no fetch, no clock, no I/O), UMD (node + browser).
 * Design authority: `Radar Registration Request — P1 Practitioner arm (paired-exit study) — 2026-10-15.md` §1–§7 as amended by `Astra P1 Practitioner Registration Review — 2026-10-15.md`
 * (BLOCKS A gate table, BLOCKS B stop / quantity / horizon, BLOCKS C freeze). Where the two differ, the review wins. Nothing here reads or writes cohort (N0 / C1), shadow or episode state.
 *
 * Every constant comes from data/forward/p1/p1-config.json (`cfg` on every call; see validateConfig). Charges come from the EXISTING declared cost scenario `cfg.costScenario` ('base' = OrdersCore.CFG
 * maker / taker / friction bps; 'allAdverse' = the §6 all-adverse scenario), applied identically to the entry, every rung, T, stop and horizon exit. OrdersCore.CFG is read, never written: the P1 horizon
 * (cfg.horizonHoldingDays = 20, fill day = day 1) lives in P1's own config, never in OrdersCore.CFG.HORIZON_BAR.
 *
 * ELIGIBILITY (BLOCKS A): retained, each must pass: data.fit, data.price, struct.lifecycle, struct.quote-breach, struct.below-rail. Replaced: C2.entry-zone -> Elo <= p <= Ehi x (1 + Y) (original gate result kept,
 * override recorded separately). Omitted as requirements, recorded pass | fail | unknown: C1.trend, C3.fresh-touch, C3.no-recent-break, C7.floor, C2.width, C6.spike, H6.rr, C4.volume24h, C4.touch-volume, C5.btc-regime.
 * Required execution inputs: designated pair on the execution venue, tick / lot / minOrder, finite geometry (S < L < T, qty >= 1 lot and >= minOrder). Rows come from the research capture directly: no screenOf, no episode-day candidates, no N0 admission.
 * GEOMETRY (BLOCKS B): S = ceilTo(fit.invalidation, tick) (never entryEconomics.stop); L = floorTo(p, tick); T = floorTo(entryEconomics.target, tick), targetSource 'independent' required; qty = floorTo(B / (L - S), lot); B = cfg.B USD (225 of 15,000).
 * LADDER (§4 + review B3): pass zones with a finite M lower bound, filtered BEFORE slot consumption (stale / uncertain / fail / unavailable / bounded-unavailable / below X_low); coincidence = inclusive intersection of [lo, hi] with [fib x (1 - c), fib x (1 + c)];
 *   rung = ceilTo(fib, tick), eligible when > L, < T and net-positive under the declared costs; prices ascending, at each price the unused coincident zone with the greatest M lower bound (tie: zone id), consumed once; identical rounded prices deduplicated; first three;
 *   tier Mlo >= X_high all-out, >= X_low fraction F of the remaining lots (lot-floored; a zero-lot partial is not a rung; dust to the final exit); no rungs after an all-out rung; no valid rung -> T-only with reason no-confluence | input-unavailable | all-below-tier.
 * EXECUTION (review B1): the cohort's evidence semantics (5-minute bars + covered Trades on the fill day and the submission-straddling bar; daily bars after; OHLC-only intervals keep the conservative convention; no Trades -> OHLC fallback) extended for partial exits:
 *   stop first in a conflict bar, no entry-bar profit credit, gap pricing at the open, crossed rungs filled ascending in one bar, T closes the remainder, bar interval recorded when the exact time is unknown, missing evidence after entry = unresolved (never "no rung filled").
 * CONTROLLER (review B2): one pair per coin; no new pair while either twin is pending / open / unresolved; after both are terminal a capture-sampled departure (price outside the frozen zone + envelope) then return (inside) re-arms; expiry / rejection re-arm by the same rule.
 * RESULT: netPnL_T, netPnL_L (cents), R_T = netPnL_T / B, R_L = netPnL_L / B, Δ = R_L − R_T, flags { unresolved, fallbackTonly, affected }. Records carry study: false while cfg.status is 'unfrozen' (development observations, never pooled with study records).
 * SUBMISSION: the cohort's ordinary-limit / fresh-ask rule, inherited exactly: ask <= S -> rejected-invalid-at-submission; fresh ask <= L -> fill now at the ask (taker, adverse); otherwise REST at L - a stale or missing quote rests too (quoteState fresh | stale | missing + age recorded). */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./orders-core.js'));
  else root.P1Core = factory(root.OrdersCore);
})(typeof self !== 'undefined' ? self : this, function (OC) {
  'use strict';
  var VERSION = 'p1-core/1', SCHEMA = 1, DAY = 86400, BAR5 = 300;
  var GATES = {
    retained: ['data.fit', 'data.price', 'struct.lifecycle', 'struct.quote-breach', 'struct.below-rail'],
    replaced: 'C2.entry-zone',
    omitted: ['C1.trend', 'C3.fresh-touch', 'C3.no-recent-break', 'C7.floor', 'C2.width', 'C6.spike', 'H6.rr', 'C4.volume24h', 'C4.touch-volume', 'C5.btc-regime']
  };
  var ALL_GATES = GATES.retained.concat([GATES.replaced], GATES.omitted);
  var ENTRY_PENDING = { resting: 1, 'pending-unresolved': 1 }, ENTRY_TERMINAL = { expired: 1, 'rejected-invalid-at-submission': 1 };
  var FALLBACKS = ['no-confluence', 'input-unavailable', 'all-below-tier'];

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  var floorTo = OC.floorTo, ceilTo = OC.ceilTo, notional = OC.notional, clean = function (x) { return Math.round(x * 1e10) / 1e10; };
  function sig(x) { return num(x) ? Number(x.toPrecision(10)) : x; }

  // ---------- configuration ----------
  // Every constant is read from cfg (data/forward/p1/p1-config.json). validateConfig returns [] when usable; the capture step refuses to run P1 on any error.
  function validateConfig(cfg) {
    var e = [];
    if (!cfg || typeof cfg !== 'object') return ['config missing'];
    [['X_low', 0], ['X_high', 0], ['F', 0], ['Y', 0], ['B', 0], ['referenceCapitalUsd', 0], ['horizonHoldingDays', 1], ['quoteFreshnessMs', 1], ['coincidencePct', 0]].forEach(function (k) {
      if (!num(cfg[k[0]]) || cfg[k[0]] < k[1]) e.push(k[0] + ' must be a finite number >= ' + k[1]);
    });
    if (num(cfg.X_low) && num(cfg.X_high) && cfg.X_low > cfg.X_high) e.push('X_low must be <= X_high');
    if (num(cfg.F) && !(cfg.F > 0 && cfg.F <= 1)) e.push('F must be in (0, 1]');
    if (num(cfg.horizonHoldingDays) && cfg.horizonHoldingDays !== Math.floor(cfg.horizonHoldingDays)) e.push('horizonHoldingDays must be an integer');
    if (cfg.expiry !== 'end-D+2') e.push("expiry must be 'end-D+2'");
    if (cfg.costScenario !== 'base' && cfg.costScenario !== 'allAdverse') e.push("costScenario must name an existing scenario: 'base' | 'allAdverse'");
    if (!Array.isArray(cfg.ratios) || !cfg.ratios.length || !cfg.ratios.every(function (r) { return num(r) && r > 0; })) e.push('ratios must be a non-empty array of positive numbers');
    if (cfg.status !== 'unfrozen' && cfg.status !== 'frozen') e.push("status must be 'unfrozen' | 'frozen'");
    if (cfg.status === 'frozen' && !(typeof cfg.frozenAt === 'string' && isFinite(Date.parse(cfg.frozenAt)))) e.push('frozenAt must be an ISO time when status is frozen');
    if (!cfg.pinned || typeof cfg.pinned !== 'object') e.push('pinned must be an object');
    return e;
  }
  function isStudy(cfg) { return !!(cfg && cfg.status === 'frozen'); }
  // Charges of the declared EXISTING cost scenario (OrdersCore.CFG basis points), recorded on every pair so the record is self-describing.
  function chargesOf(cfg) {
    var C = OC.CFG, all = cfg && cfg.costScenario === 'allAdverse';
    return { scenario: cfg ? cfg.costScenario : null, makerBp: C.MAKER_BP, takerBp: C.TAKER_BP, frictionBaseBp: C.FRICTION_BASE_BP, frictionAdverseBp: C.FRICTION_ADVERSE_BP, mode: all ? 'allAdverse' : 'base' };
  }
  function charges(nCents, kind, adverse, cfg) { return OC.sideCharges(nCents, kind, adverse, chargesOf(cfg).mode); }

  // ---------- 1a eligibility ----------
  function gateStates(row) {
    var out = {}, gs = row && Array.isArray(row.gates) ? row.gates : [];
    ALL_GATES.forEach(function (id) {
      var g = null; for (var i = 0; i < gs.length; i++) if (gs[i] && gs[i].id === id) { g = gs[i]; break; }
      out[id] = !g ? 'unknown' : g.pass === true ? 'pass' : g.pass === false ? 'fail' : 'unknown';
    });
    return out;
  }
  function metaOk(m) { return !!(m && num(m.tick) && m.tick > 0 && num(m.lot) && m.lot > 0 && num(m.minOrder) && m.minOrder > 0); }
  // row: the capture's research row { fit:{invalidation,...}, price, gates:[{id,pass}], entryEconomics:{entryZone,[entryLow,entryHigh],target,targetSource,stop} }; ctx: { pair, venueEligible, meta:{tick,lot,minOrder} }.
  function eligibility(row, ctx, cfg) {
    ctx = ctx || {}; var reasons = [], gates = gateStates(row), ee = row && row.entryEconomics || null, p = row ? row.price : null;
    GATES.retained.forEach(function (id) { if (gates[id] !== 'pass') reasons.push('gate:' + id + ':' + gates[id]); });
    var zone = ee ? (Array.isArray(ee.entryZone) ? ee.entryZone : (num(ee.entryLow) && num(ee.entryHigh) ? [ee.entryLow, ee.entryHigh] : null)) : null;
    var Elo = zone && num(zone[0]) ? zone[0] : null, Ehi = zone && num(zone[1]) ? zone[1] : null, Y = cfg.Y, envHi = num(Ehi) ? Ehi * (1 + Y) : null;
    var priceOk = num(p) && p > 0, zoneOk = num(Elo) && num(Ehi) && Elo > 0 && Ehi >= Elo;
    if (!priceOk) reasons.push('price-unavailable');
    if (!zoneOk) reasons.push('entry-zone-unavailable');
    var inEnv = priceOk && zoneOk ? (p >= Elo && p <= envHi) : null, entryKind = inEnv ? (p <= Ehi ? 'zone' : 'envelope') : null;
    if (priceOk && zoneOk && !inEnv) reasons.push(p < Elo ? 'below-entry-zone' : 'above-envelope');
    if (!ctx.pair || ctx.venueEligible === false) reasons.push('no-execution-pair');
    if (!metaOk(ctx.meta)) reasons.push('metadata-unavailable');
    var geometry = null;
    if (reasons.length === 0 || (priceOk && metaOk(ctx.meta))) { geometry = orderGeometry(row, ctx.meta, cfg); if (!geometry.ok) geometry.reasons.forEach(function (r) { if (reasons.indexOf(r) < 0) reasons.push(r); }); }
    return {
      eligible: reasons.length === 0, reasons: reasons, gates: gates,
      entryZoneGate: { original: gates[GATES.replaced], override: { rule: 'Elo <= p <= Ehi x (1 + Y)', Y: Y, pass: inEnv, price: priceOk ? p : null, Elo: Elo, Ehi: Ehi, envelopeHi: envHi == null ? null : sig(envHi) } },
      entryKind: entryKind, distanceToZoneTopPct: priceOk && zoneOk ? sig((p - Ehi) / Ehi * 100) : null,
      retained: GATES.retained.map(function (id) { return { id: id, state: gates[id] }; }), omittedDiagnostics: GATES.omitted.map(function (id) { return { id: id, state: gates[id] }; }),
      geometry: geometry
    };
  }

  // ---------- 1b order geometry (BLOCKS B) ----------
  // quote = the execution-venue metadata { tick, lot, minOrder } (the price itself is the row's capture price p).
  function orderGeometry(row, quote, cfg) {
    var r = { ok: false, reasons: [], S: null, L: null, T: null, tick: null, lot: null, lotsInv: null, minOrder: null, Q: null, qty: null, Bcents: Math.round(cfg.B * 100), Busd: cfg.B, referenceCapitalUsd: cfg.referenceCapitalUsd,
      stopSource: 'fit.invalidation ceil-to-tick', targetSource: null, raw: {} };
    var fit = row && row.fit || null, ee = row && row.entryEconomics || null, p = row ? row.price : null;
    r.raw = { price: num(p) ? p : null, invalidation: fit && num(fit.invalidation) ? fit.invalidation : null, target: ee && num(ee.target) ? ee.target : null, entryEconomicsStop: ee && num(ee.stop) ? ee.stop : null, targetSource: ee ? ee.targetSource || null : null };
    if (!metaOk(quote)) { r.reasons.push('metadata-unavailable'); return r; }
    r.tick = quote.tick; r.lot = quote.lot; r.minOrder = quote.minOrder; r.lotsInv = Math.round(1 / quote.lot); r.targetSource = r.raw.targetSource;
    if (!num(p) || !(p > 0)) r.reasons.push('price-unavailable');
    if (!(fit && num(fit.invalidation) && fit.invalidation > 0)) r.reasons.push('invalidation-unavailable');
    if (!(ee && num(ee.target) && ee.target > 0)) r.reasons.push('target-unavailable');
    else if (ee.targetSource !== 'independent') r.reasons.push('target-not-independent');
    if (r.reasons.length) return r;
    r.S = ceilTo(fit.invalidation, quote.tick); r.L = floorTo(p, quote.tick); r.T = floorTo(ee.target, quote.tick);
    if (!(num(r.S) && num(r.L) && num(r.T) && r.S > 0 && r.L > 0 && r.T > 0)) { r.reasons.push('geometry-not-finite'); return r; }
    if (!(r.S < r.L && r.L < r.T)) { r.reasons.push('geometry-order'); return r; }
    r.Q = Math.floor((cfg.B / (r.L - r.S)) * r.lotsInv + 1e-9); r.qty = r.Q / r.lotsInv;
    if (!(r.Q >= 1)) { r.reasons.push('qty-zero'); return r; }
    if (r.qty < r.minOrder - 1e-12) { r.reasons.push('qty-below-minimum'); return r; }
    r.ok = true; return r;
  }

  // ---------- 1c ladder plan (§4, review B3) ----------
  // zonesForVenue: { available, reason, states:[codes], zones:[{ id, lo, hi, verdict, Mlo, Mhi, MhiUnbounded }], snapshot, baseline } for the EXECUTION venue only (never summed, never chosen by tier).
  // fibLevels: { available, reason, levels:[{ ratio, kind, price }], leg }. geometry: orderGeometry() result. Deterministic; every rejected candidate is listed with its reason.
  function ladderPlan(zonesForVenue, fibLevels, geometry, cfg) {
    var ch = chargesOf(cfg), rej = [], plan = { version: VERSION, rungs: [], tOnly: true, fallbackReason: null, rejected: rej, remainingAfterLadder: null,
      inputs: { X_low: cfg.X_low, X_high: cfg.X_high, F: cfg.F, coincidencePct: cfg.coincidencePct, ratios: cfg.ratios.slice(), costScenario: ch.scenario, exitChargeBp: ch.makerBp + ch.frictionBaseBp,
        fibAvailable: !!(fibLevels && fibLevels.available), fibReason: fibLevels ? (fibLevels.reason || null) : 'missing', zonesAvailable: !!(zonesForVenue && zonesForVenue.available), zonesReason: zonesForVenue ? (zonesForVenue.reason || null) : 'missing', zoneStates: zonesForVenue && zonesForVenue.states ? zonesForVenue.states.slice() : null } };
    if (!geometry || !geometry.ok) { plan.fallbackReason = 'input-unavailable'; rej.push({ kind: 'geometry', reason: 'geometry-unavailable' }); return plan; }
    var remaining = geometry.Q, L = geometry.L, T = geometry.T, tick = geometry.tick;
    plan.remainingAfterLadder = remaining;
    var fibOk = !!(fibLevels && fibLevels.available && Array.isArray(fibLevels.levels) && fibLevels.levels.length), zonesOk = !!(zonesForVenue && zonesForVenue.available && Array.isArray(zonesForVenue.zones));
    if (!fibOk) rej.push({ kind: 'fib', reason: 'fib-unavailable', detail: plan.inputs.fibReason });
    if (!zonesOk) rej.push({ kind: 'book', reason: 'zones-unavailable', detail: plan.inputs.zonesReason });
    var states = zonesOk ? (zonesForVenue.states || []) : [], stale = states.indexOf('stale') >= 0, freshUnknown = states.indexOf('freshnessUnknown') >= 0;
    var passFinite = [], usable = [];
    if (zonesOk) zonesForVenue.zones.forEach(function (z) {
      var id = z.id != null ? String(z.id) : (sig(z.lo) + '-' + sig(z.hi));
      if (stale) { rej.push({ kind: 'zone', id: id, reason: 'stale' }); return; }
      if (freshUnknown) { rej.push({ kind: 'zone', id: id, reason: 'freshness-unknown' }); return; }
      if (z.verdict !== 'pass') { rej.push({ kind: 'zone', id: id, reason: z.verdict == null ? 'unavailable' : String(z.verdict) }); return; }
      if (!num(z.Mlo)) { rej.push({ kind: 'zone', id: id, reason: 'bounded-unavailable' }); return; }
      if (!(num(z.lo) && num(z.hi))) { rej.push({ kind: 'zone', id: id, reason: 'bounds-unavailable' }); return; }
      var zz = { id: id, lo: z.lo, hi: z.hi, Mlo: z.Mlo, Mhi: num(z.Mhi) ? z.Mhi : null, used: false };
      passFinite.push(zz);
      if (z.Mlo >= cfg.X_low) usable.push(zz); else rej.push({ kind: 'zone', id: id, reason: 'below-tier', detail: { Mlo: z.Mlo, X_low: cfg.X_low } });
    });
    if (!fibOk || !zonesOk || stale || freshUnknown) { plan.fallbackReason = 'input-unavailable'; return plan; }
    var c = cfg.coincidencePct / 100, levels = fibLevels.levels.filter(function (lv) { return num(lv.price) && cfg.ratios.indexOf(lv.ratio) >= 0; })
      .map(function (lv) { return { ratio: lv.ratio, kind: lv.kind || null, fibPrice: lv.price, rungPrice: ceilTo(lv.price, tick), lo: lv.price * (1 - c), hi: lv.price * (1 + c) }; })
      .sort(function (a, b) { return a.rungPrice - b.rungPrice || a.ratio - b.ratio; });
    var coinc = function (z, lv) { return z.hi >= lv.lo && z.lo <= lv.hi; };
    var anyCoincident = false, tierCoincident = false;
    levels.forEach(function (lv) { if (passFinite.some(function (z) { return coinc(z, lv); })) anyCoincident = true; if (usable.some(function (z) { return coinc(z, lv); })) tierCoincident = true; });
    var seen = {}, allOut = false, bp = (ch.makerBp + ch.frictionBaseBp) / 10000;
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i], base = { kind: 'level', ratio: lv.ratio, fibPrice: sig(lv.fibPrice), rungPrice: lv.rungPrice };
      if (allOut) { rej.push(Object.assign({ reason: 'after-all-out-rung' }, base)); continue; }
      if (plan.rungs.length >= 3) { rej.push(Object.assign({ reason: 'slots-exhausted' }, base)); continue; }
      if (seen[lv.rungPrice]) { rej.push(Object.assign({ reason: 'duplicate-price' }, base)); continue; }
      if (!(lv.rungPrice > L)) { rej.push(Object.assign({ reason: 'at-or-below-entry' }, base)); continue; }
      if (!(lv.rungPrice < T)) { rej.push(Object.assign({ reason: 'at-or-above-target' }, base)); continue; }
      var netPerUnit = lv.rungPrice - L - (lv.rungPrice + L) * bp;
      if (!(netPerUnit > 0)) { rej.push(Object.assign({ reason: 'not-net-positive', detail: { netPerUnit: sig(netPerUnit) } }, base)); continue; }
      var cands = usable.filter(function (z) { return !z.used && coinc(z, lv); });
      if (!cands.length) { rej.push(Object.assign({ reason: 'no-coincident-zone' }, base)); continue; }
      cands.sort(function (a, b) { return b.Mlo - a.Mlo || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
      var z = cands[0]; z.used = true;
      var tier = z.Mlo >= cfg.X_high ? 'all' : 'fraction', lots = tier === 'all' ? remaining : Math.floor(remaining * cfg.F + 1e-9);
      if (!(lots >= 1)) { rej.push(Object.assign({ reason: 'zero-lot-partial', zoneId: z.id, detail: { remainingLots: remaining, F: cfg.F } }, base)); continue; }
      seen[lv.rungPrice] = 1; remaining -= lots;
      plan.rungs.push({ k: plan.rungs.length + 1, price: lv.rungPrice, fibRatio: lv.ratio, fibKind: lv.kind, fibPrice: sig(lv.fibPrice), zoneId: z.id, zoneLo: z.lo, zoneHi: z.hi, Mlo: z.Mlo, Mhi: z.Mhi, tier: tier, lots: lots, qty: lots / geometry.lotsInv, netPerUnit: sig(netPerUnit) });
      if (tier === 'all') allOut = true;
    }
    plan.remainingAfterLadder = remaining;
    plan.tOnly = plan.rungs.length === 0;
    plan.fallbackReason = plan.tOnly ? (anyCoincident && !tierCoincident ? 'all-below-tier' : 'no-confluence') : null;
    return plan;
  }

  // ---------- 1d re-arm controller (review B2) ----------
  // state (per coin): null | { pairId, Elo, envelopeHi, departed }. sample: { price, activePair } where activePair = the state's pair is pending / open / unresolved (not terminal).
  // Returns { allow, reason, state } - state is the NEW controller state after observing this capture's price; the caller stores it.
  function rearm(state, sample, cfg) {
    var s = state ? clone(state) : null, p = sample ? sample.price : null;
    if (!s || !s.pairId) return { allow: true, reason: 'no-prior-pair', state: s };
    if (sample && sample.activePair) return { allow: false, reason: 'active-pair', state: s };
    if (!num(p)) return { allow: false, reason: 'price-unavailable', state: s };
    var inside = p >= s.Elo && p <= s.envelopeHi;
    if (!s.departed) {
      if (!inside) { s.departed = true; s.departedAt = sample.captureId || null; return { allow: false, reason: 'departure-observed', state: s }; }
      return { allow: false, reason: 'awaiting-departure', state: s };
    }
    if (inside) return { allow: true, reason: 'returned', state: s };
    return { allow: false, reason: 'awaiting-return', state: s };
  }
  function controllerAfterPair(pair) { return { pairId: pair.pairId, Elo: pair.zone.Elo, envelopeHi: pair.zone.envelopeHi, departed: false, since: pair.captureId }; }

  // ---------- pair creation: the cohort's ordinary-limit / fresh-ask submission rule on one shared entry ----------
  // opp: { cgId, pair, venue, entryKind, zone:{Elo,Ehi,envelopeHi}, context }; geometry: orderGeometry(); plan: ladderPlan(); quote: { tSubSec, quoteObservedAtSec, ask, bid, last } | { tSubSec, missing:true, error }; capture: { captureId, generationId, date, issueTimeUtc, issueSec, inputCutoffSec }.
  function newPair(opp, geometry, plan, quote, capture, cfg) {
    var tDec = capture.issueSec, q = quote || null, ch = chargesOf(cfg);
    // quote states (analysis-thread ruling 2026-10-16 on the 52s ambiguity): fresh = usable for the fill-at-ask decision; stale = present but older than cfg.quoteFreshnessMs (or observed before t_dec); missing = no ask.
    // A stale or missing quote never rejects: the order RESTS at L from the attempted-fetch time, exactly the cohort's ordinary-limit / fresh-ask rule.
    var hasAsk = !!q && !q.missing && num(q.tSubSec) && num(q.quoteObservedAtSec) && num(q.ask) && q.ask > 0 && q.quoteObservedAtSec <= q.tSubSec;
    var ageMs = hasAsk ? (q.tSubSec - q.quoteObservedAtSec) * 1000 : null, qOk = hasAsk && ageMs <= cfg.quoteFreshnessMs && q.tSubSec >= tDec, quoteState = qOk ? 'fresh' : hasAsk ? 'stale' : 'missing';
    var tSub = q && num(q.tSubSec) && q.tSubSec >= tDec ? q.tSubSec : tDec;   // never earlier than t_dec; never "midnight"
    var P = { schemaVersion: SCHEMA, pairId: 'P1-' + capture.date + '-' + opp.cgId, cgId: opp.cgId, pair: opp.pair, venue: opp.venue || 'kraken', study: isStudy(cfg), configStatus: cfg.status,
      captureId: capture.captureId, generationId: capture.generationId || capture.captureId, issueDate: capture.date, issueTimeUtc: capture.issueTimeUtc || null, tDecSec: tDec, dId: capture.inputCutoffSec,
      entryKind: opp.entryKind || null, zone: clone(opp.zone), context: clone(opp.context || null),
      geometry: { S: geometry.S, L: geometry.L, T: geometry.T, tick: geometry.tick, lot: geometry.lot, lotsInv: geometry.lotsInv, minOrder: geometry.minOrder, Q: geometry.Q, qty: geometry.qty, Bcents: geometry.Bcents, Busd: geometry.Busd, referenceCapitalUsd: geometry.referenceCapitalUsd, stopSource: geometry.stopSource, targetSource: geometry.targetSource, raw: clone(geometry.raw) },
      plan: clone(plan), charges: ch, horizonHoldingDays: cfg.horizonHoldingDays, expiry: cfg.expiry,
      submission: { submittedAtSec: tSub, quoteObservedAtSec: hasAsk ? q.quoteObservedAtSec : null, quoteState: quoteState, quoteAgeMs: ageMs, quoteFreshnessMs: cfg.quoteFreshnessMs, quoteStatus: qOk ? 'ok' : 'quote-missing', quote: hasAsk ? { ask: q.ask, bid: num(q.bid) ? q.bid : null, last: num(q.last) ? q.last : null } : null, error: q && q.error ? String(q.error) : null },
      entry: { status: 'resting', w0: 0, eligibleDone: 0, cursorSec: tSub, expiryAtSec: capture.inputCutoffSec + 3 * DAY, fill: null, unresolved: null, bars: [], intraday: { granularity: BAR5, bars: [], trades: [] }, noFill: [] },
      position: null, twins: { T: newTwin('T', geometry.Q, []), L: newTwin('L', geometry.Q, plan && plan.rungs ? plan.rungs : []) }, events: [] };
    ev(P, capture, 'issued', {});
    ev(P, capture, 'submitted', { tSubSec: tSub, quoteState: quoteState, ask: hasAsk ? q.ask : null });
    if (!qOk) { P.status = statusOf(P); return P; }   // stale / missing quote: rests at L from tSub; no immediate fill, no rejection (the cohort's rule a.)
    if (q.ask <= P.geometry.S) { P.entry.status = 'rejected-invalid-at-submission'; ev(P, capture, 'rejected-invalid-at-submission', { ask: q.ask, S: P.geometry.S }); P.status = statusOf(P); return P; }
    if (q.ask <= P.geometry.L) applyEntryFill(P, { price: q.ask, reason: 'fill-crossing-ask', kind: 'taker', adverse: true, tSec: tSub, barId: tSub, dayId: dayOf(tSub), daily: false, sizeProxy: 'top-of-book' }, capture, cfg);
    P.status = statusOf(P);
    return P;
  }
  function newTwin(id, Q, rungs) { return { id: id, remainingLots: Q, rungs: rungs.map(function (r) { return { k: r.k, price: r.price, lots: r.lots, tier: r.tier, filled: false }; }), exits: [], closed: false, closedAtHoldingDay: null }; }
  function ev(P, capture, type, extra) { P.events.push(Object.assign({ type: type, captureId: capture.captureId, date: capture.date }, extra || {})); }
  function dayOf(t) { return Math.floor(t / DAY) * DAY; }
  function entryPending(P) { return !!ENTRY_PENDING[P.entry.status]; }
  function entryTerminal(P) { return !!ENTRY_TERMINAL[P.entry.status]; }
  function twinsOpen(P) { return !!P.entry.fill && (!P.twins.T.closed || !P.twins.L.closed); }
  function isActive(P) { return entryPending(P) || twinsOpen(P); }   // pending, open or unresolved: the controller blocks a new pair for the coin
  function applyEntryFill(P, spec, capture, cfg) {
    var g = P.geometry, n = notional(g.Q, g.lotsInv, spec.price), c = charges(n, spec.kind, spec.adverse, cfg);
    P.entry.fill = { price: spec.price, lots: g.Q, qty: g.qty, barId: spec.barId, dayId: spec.dayId, tSec: spec.tSec, reason: spec.reason, kind: spec.kind, adverse: spec.adverse, notionalCents: n, feeCents: c.feeCents, frictionCents: c.frictionCents, captureId: capture.captureId, date: capture.date };
    if (spec.sizeProxy) P.entry.fill.sizeProxy = spec.sizeProxy;
    P.entry.status = 'open'; P.entry.unresolved = null;
    P.position = { hDone: spec.daily ? 1 : 0, cursorSec: spec.daily ? null : spec.tSec, unresolved: null, bars: [], intraday: { granularity: BAR5, bars: [], trades: [] } };
    ev(P, capture, 'filled', { barId: spec.barId, price: spec.price, reason: spec.reason });
  }

  // ---------- executions (partial-exit extension of the cohort's exit rules) ----------
  function exec(P, twin, x, bar, capture, h, cfg) {   // x: { reason, price, kind, adverse, lots, tSec? , rungK? }
    var g = P.geometry, lots = Math.min(x.lots, twin.remainingLots); if (!(lots >= 1)) return;
    var n = notional(lots, g.lotsInv, x.price), c = charges(n, x.kind, x.adverse, cfg);
    var rec = { twin: twin.id, reason: x.reason, price: x.price, lots: lots, qty: lots / g.lotsInv, kind: x.kind, adverse: x.adverse, notionalCents: n, feeCents: c.feeCents, frictionCents: c.frictionCents,
      barId: bar.id, tSec: num(x.tSec) ? x.tSec : null, interval: num(x.tSec) ? null : [bar.id, bar.id + (bar.span || DAY)], holdingDay: h, rungK: x.rungK == null ? null : x.rungK, captureId: capture.captureId, date: capture.date };
    twin.exits.push(rec); twin.remainingLots -= lots;
    if (x.rungK != null) twin.rungs.forEach(function (r) { if (r.k === x.rungK) { r.filled = true; r.filledLots = lots; } });
    if (twin.remainingLots <= 0) { twin.closed = true; twin.closedAtHoldingDay = h; }
    ev(P, capture, 'exit', { twin: twin.id, barId: bar.id, reason: x.reason, price: x.price, lots: lots, rungK: rec.rungK });
  }
  function openRungs(twin) { return twin.rungs.filter(function (r) { return !r.filled; }).sort(function (a, b) { return a.price - b.price; }); }
  function nextBarrier(twin, T) { var r = openRungs(twin); return r.length ? Math.min(r[0].price, T) : T; }
  // One FULL bar (5-minute or daily) for one twin. Stop first; gap pricing at the open; crossed rungs ascending; T closes the remainder; horizon closes at the bar's close. Trade-through convention (price + tick) as OrdersCore.exitRules.
  function twinBar(P, twin, bar, isHorizon) {
    var g = P.geometry, S = g.S, T = g.T, tk = g.tick, upT = clean(T + tk), out = [], rem = twin.remainingLots;
    if (twin.closed || rem <= 0) return out;
    if (!twin.rungs.length) {   // the single-target twin: the cohort's exitRules verbatim
      var r = OC.exitRules(bar, { S: S, T: T, tick: tk }, isHorizon); if (r) out.push({ reason: r.reason, price: r.price, kind: r.kind, adverse: r.adverse, lots: rem });
      return out;
    }
    if (bar.open <= S) { out.push({ reason: 'gap-stop', price: bar.open, kind: 'taker', adverse: true, lots: rem }); return out; }
    var crossed = openRungs(twin).filter(function (x) { return bar.high >= clean(x.price + tk); }), tHit = bar.high >= upT;
    if (bar.low <= S) { out.push({ reason: (crossed.length || tHit) ? 'conflict-stop' : 'stop', price: S, kind: 'taker', adverse: !!(crossed.length || tHit), lots: rem }); return out; }
    crossed.forEach(function (x) {
      if (rem <= 0) return; var gap = bar.open >= clean(x.price + tk), lots = Math.min(x.lots, rem);
      out.push({ reason: gap ? 'gap-rung' : 'rung', price: gap ? bar.open : x.price, kind: 'maker', adverse: false, lots: lots, rungK: x.k }); rem -= lots;
    });
    if (tHit && rem > 0) { var gapT = bar.open >= upT; out.push({ reason: gapT ? 'gap-target' : 'target', price: gapT ? bar.open : T, kind: 'maker', adverse: false, lots: rem }); rem = 0; }
    if (isHorizon && rem > 0) out.push({ reason: 'horizon', price: bar.close, kind: 'taker', adverse: false, lots: rem });
    return out;
  }
  // Prints of a partial bar in time order (covered Trades): at/below S -> stop on the remainder; at/above a rung -> that rung (ascending); at/above T -> T closes the remainder.
  function twinTrades(P, twin, list) {
    var g = P.geometry, S = g.S, T = g.T, out = [], rem = twin.remainingLots, open = openRungs(twin).map(function (r) { return Object.assign({}, r); });
    if (twin.closed || rem <= 0) return out;
    for (var i = 0; i < list.length && rem > 0; i++) {
      var x = list[i];
      if (x.p <= S) { out.push({ reason: 'stop', price: S, kind: 'taker', adverse: false, lots: rem, tSec: x.t }); rem = 0; break; }
      while (open.length && x.p >= open[0].price && rem > 0) { var r = open.shift(), lots = Math.min(r.lots, rem); out.push({ reason: 'rung', price: r.price, kind: 'maker', adverse: false, lots: lots, tSec: x.t, rungK: r.k }); rem -= lots; }
      if (x.p >= T && rem > 0) { out.push({ reason: 'target', price: T, kind: 'maker', adverse: false, lots: rem, tSec: x.t }); rem = 0; }
    }
    return out;
  }
  // fill-candle convention (§4.4, unamended): intrabar order unknown, a stop in the fill candle is honoured, no target / rung credit.
  function fillCandleExit(P, bar, gapOpenFill) {
    if (gapOpenFill && bar.open <= P.geometry.S) return { reason: 'gap-stop-on-fill', price: bar.open, kind: 'taker', adverse: true };
    if (bar.low <= P.geometry.S) return { reason: 'ambiguous-stop', price: P.geometry.S, kind: 'taker', adverse: true };
    return null;
  }
  function bothTwins(P, fn) { ['T', 'L'].forEach(function (k) { fn(P.twins[k]); }); }

  // ---------- evidence (the cohort's model: closed well-formed 5-minute bars, complete Trades slices) ----------
  function bar5Ok(b) { return !!b && num(b.id) && b.id % BAR5 === 0 && num(b.open) && num(b.high) && num(b.low) && num(b.close) && b.low <= b.high && b.open >= b.low && b.open <= b.high && b.close >= b.low && b.close <= b.high; }
  function makeCtx(evidence, cfg) {
    var cap = evidence.capture, issueSec = cap && num(cap.issueSec) ? cap.issueSec : null, bars = {}, daily = {};
    (evidence.bars5 || []).forEach(function (b) { if (bar5Ok(b) && (issueSec == null || b.id + BAR5 <= issueSec)) bars[b.id] = b; });
    (evidence.candles || []).forEach(function (c) { var id = num(c.id) ? c.id : c.time; if (num(id) && num(c.open) && num(c.high) && num(c.low) && num(c.close)) daily[id] = { id: id, open: c.open, high: c.high, low: c.low, close: c.close }; });
    return { cap: cap, bars: bars, slices: Array.isArray(evidence.trades) ? evidence.trades : [], daily: daily, needs: [], cfg: cfg };
  }
  function needOnce(ctx, n) { for (var i = 0; i < ctx.needs.length; i++) { var x = ctx.needs[i]; if (x.kind === n.kind && x.fromSec === n.fromSec && x.toSec === n.toSec && x.pair === n.pair) return; } ctx.needs.push(n); }
  function tradesFor(ctx, P, lo, hi) {
    var bad = false;
    for (var i = 0; i < ctx.slices.length; i++) {
      var s = ctx.slices[i]; if (!s || !(s.fromSec <= lo && s.toSec >= hi)) continue;
      if (s.complete !== true) { bad = true; continue; }
      var list = (s.trades || []).filter(function (x) { return x && num(x.t) && num(x.p) && x.t >= lo && x.t < hi; }).map(function (x, k) { return { t: x.t, p: x.p, n: x.n != null ? x.n : k }; })
        .sort(function (a, b) { return a.t - b.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0); });
      return { status: 'ok', list: list };
    }
    if (bad) return { status: 'unavailable' };
    needOnce(ctx, { kind: 'trades', cgId: P.cgId, pair: P.pair, fromSec: lo, toSec: hi });
    return { status: 'need' };
  }
  function pushBar5(store, bar) { var n = store.bars.length; if (n && store.bars[n - 1].id >= bar.id) return; store.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close }); }
  function storeSlice(store, role, lo, hi, list) { store.trades.push({ role: role, fromSec: lo, toSec: hi, count: list.length, trades: list.slice(0, OC.CFG.TRADES_STORE_MAX).map(function (x) { return [x.t, x.p]; }), truncated: list.length > OC.CFG.TRADES_STORE_MAX }); }
  function markUnresolved(P, where, capture, phase, fromSec, toSec, reason, ctx) {
    var prev = where.unresolved, same = prev && prev.phase === phase && prev.fromSec === fromSec && prev.reason === reason;
    where.unresolved = { phase: phase, fromSec: fromSec, toSec: toSec, reason: reason, sinceCaptureId: same ? prev.sinceCaptureId : capture.captureId, captures: same ? (prev.lastCaptureId === capture.captureId ? prev.captures : prev.captures + 1) : 1, lastCaptureId: capture.captureId };
    if (phase === 'entry' && P.entry.status === 'resting') P.entry.status = 'pending-unresolved';
    ev(P, capture, 'unresolved', { phase: phase, fromSec: fromSec, reason: reason });
    if (ctx && reason === 'bars5-missing') needOnce(ctx, { kind: 'bars5', cgId: P.cgId, pair: P.pair, fromSec: fromSec, toSec: toSec });
  }
  function clearUnresolved(P, where, capture) { if (where.unresolved) { ev(P, capture, 'resumed', { phase: where.unresolved.phase, fromSec: where.unresolved.fromSec }); where.unresolved = null; } if (P.entry.status === 'pending-unresolved') P.entry.status = 'resting'; }

  // ---------- entry phase (shared by both twins): windows w = 0 [submittedAtSec, end of D) on 5-minute bars, w = 1, 2 the daily bars D+1, D+2; expiry end-D+2 ----------
  function entryIntraday(P, ctx, capture, cur, endEff, cfg) {
    var e = P.entry, g = P.geometry, Lm = clean(g.L - g.tick), guard = 0;
    while (cur < endEff && guard++ < 400) {
      var b = Math.floor(cur / BAR5) * BAR5, bend = b + BAR5, segEnd = Math.min(bend, endEff), bar = ctx.bars[b];
      if (!bar) { e.cursorSec = cur; markUnresolved(P, e, capture, 'entry', cur, endEff, 'bars5-missing', ctx); return 'unresolved'; }
      var partial = cur > b || segEnd < bend, b5 = { id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close, span: BAR5 };
      if (!partial) {
        var gap = bar.open < g.L, lim = !gap && bar.low <= Lm;
        if (gap || lim) {
          if (e.status === 'pending-unresolved') clearUnresolved(P, e, capture);
          pushBar5(e.intraday, bar);
          applyEntryFill(P, { price: gap ? bar.open : g.L, reason: gap ? 'fill-gap-open' : 'limit', kind: gap ? 'taker' : 'maker', adverse: gap, tSec: b, barId: b, dayId: dayOf(b), daily: false }, capture, cfg);
          var r = fillCandleExit(P, bar, gap); P.position.cursorSec = bend;
          if (r) { bothTwins(P, function (tw) { exec(P, tw, Object.assign({ lots: tw.remainingLots }, r), b5, capture, 1, cfg); }); P.position.hDone = 1; }
          return 'filled';
        }
        pushBar5(e.intraday, bar); cur = segEnd; e.cursorSec = cur; continue;
      }
      if (bar.low > Lm) { pushBar5(e.intraday, bar); cur = segEnd; e.cursorSec = cur; continue; }
      var tr = tradesFor(ctx, P, cur, bend);
      if (tr.status !== 'ok') { e.cursorSec = cur; markUnresolved(P, e, capture, 'entry', cur, endEff, tr.status === 'need' ? 'trades-pending' : 'trades-unavailable', ctx); return 'unresolved'; }
      var fi = -1; for (var i = 0; i < tr.list.length; i++) { if (tr.list[i].t >= segEnd) break; if (tr.list[i].p <= Lm) { fi = i; break; } }
      storeSlice(e.intraday, 'entry', cur, bend, tr.list);
      if (fi < 0) { pushBar5(e.intraday, bar); cur = segEnd; e.cursorSec = cur; continue; }
      if (e.status === 'pending-unresolved') clearUnresolved(P, e, capture);
      pushBar5(e.intraday, bar);
      applyEntryFill(P, { price: g.L, reason: 'limit', kind: 'maker', adverse: false, tSec: tr.list[fi].t, barId: b, dayId: dayOf(b), daily: false }, capture, cfg);
      P.position.cursorSec = bend;
      for (var j = fi; j < tr.list.length; j++) if (tr.list[j].p <= g.S) { var st = { reason: 'stop', price: g.S, kind: 'taker', adverse: false, tSec: tr.list[j].t }; bothTwins(P, function (tw) { exec(P, tw, Object.assign({ lots: tw.remainingLots }, st), b5, capture, 1, cfg); }); P.position.hDone = 1; break; }
      return 'filled';
    }
    return 'done';
  }
  function adjudicateEntry(P, ctx, capture, cfg) {
    var e = P.entry, g = P.geometry, guard = 0;
    while (guard++ < 64) {
      if (!entryPending(P)) return;
      if (e.eligibleDone >= 3) { e.status = 'expired'; ev(P, capture, 'expired', { windows: 3 }); return; }
      var w = e.eligibleDone, ws = w === 0 ? P.submission.submittedAtSec : P.dId + w * DAY, we = P.dId + (w + 1) * DAY;
      if (we > ctx.cap.inputCutoffSec) return;   // the window is not over yet: nothing is due
      var cur = e.cursorSec == null ? ws : e.cursorSec;
      if (w >= 1 && cur === ws) {   // daily window
        var bar = ctx.daily[ws];
        if (!bar) { markUnresolved(P, e, capture, 'entry', ws, we, 'daily-bar-unavailable', ctx); return; }
        if (e.unresolved || e.status === 'pending-unresolved') clearUnresolved(P, e, capture);
        e.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        var gapD = bar.open < g.L, limD = !gapD && bar.low <= clean(g.L - g.tick);
        if (gapD || limD) {
          applyEntryFill(P, { price: gapD ? bar.open : g.L, reason: gapD ? 'fill-gap-open' : 'limit', kind: gapD ? 'taker' : 'maker', adverse: gapD, tSec: ws, barId: bar.id, dayId: ws, daily: true }, capture, cfg);
          var rd = fillCandleExit(P, bar, gapD); if (rd) bothTwins(P, function (tw) { exec(P, tw, Object.assign({ lots: tw.remainingLots }, rd), { id: bar.id, span: DAY }, capture, 1, cfg); });
          positionPhase(P, ctx, capture, cfg); return;
        }
        e.eligibleDone++; e.cursorSec = we; e.noFill.push({ w: w, barId: bar.id, captureId: capture.captureId }); continue;
      }
      var res = entryIntraday(P, ctx, capture, cur, we, cfg);
      if (res === 'unresolved') return;
      if (res === 'filled') { positionPhase(P, ctx, capture, cfg); return; }
      if (e.unresolved || e.status === 'pending-unresolved') clearUnresolved(P, e, capture);
      e.noFill.push({ w: w, fromSec: ws, toSec: we, captureId: capture.captureId });
      e.eligibleDone++; e.cursorSec = we;
    }
  }

  // ---------- position phase: fill-day 5-minute bars (holding day 1), then daily bars 2..horizon, shared cursor, both twins on the same bars ----------
  function positionIntraday(P, ctx, capture, cfg) {
    var pos = P.position, f = P.entry.fill, dayEnd = f.dayId + DAY, g = P.geometry;
    if (dayEnd > ctx.cap.inputCutoffSec) return 'wait';
    var cur = pos.cursorSec == null ? f.tSec : pos.cursorSec, guard = 0;
    while (cur < dayEnd && guard++ < 400 && twinsOpen(P)) {
      var b = Math.floor(cur / BAR5) * BAR5, bend = b + BAR5, bar = ctx.bars[b];
      if (!bar) { pos.cursorSec = cur; markUnresolved(P, pos, capture, 'exit', cur, dayEnd, 'bars5-missing', ctx); return 'unresolved'; }
      var b5 = { id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close, span: BAR5 };
      if (cur === b) {   // full bar
        pushBar5(pos.intraday, bar);
        bothTwins(P, function (tw) { twinBar(P, tw, bar, false).forEach(function (x) { exec(P, tw, x, b5, capture, 1, cfg); }); });
      } else {           // partial bar (the one holding the fill): only prints at/after the fill time count; the range decides, Trades when the range touches S or the nearest barrier
        var barrier = Math.min(nextBarrier(P.twins.T, g.T), nextBarrier(P.twins.L, g.T));
        if (bar.low <= g.S || bar.high >= barrier) {
          var tr = tradesFor(ctx, P, cur, bend);
          if (tr.status !== 'ok') { pos.cursorSec = cur; markUnresolved(P, pos, capture, 'exit', cur, dayEnd, tr.status === 'need' ? 'trades-pending' : 'trades-unavailable', ctx); return 'unresolved'; }
          storeSlice(pos.intraday, 'exit', cur, bend, tr.list);
          pushBar5(pos.intraday, bar);
          bothTwins(P, function (tw) { twinTrades(P, tw, tr.list).forEach(function (x) { exec(P, tw, x, b5, capture, 1, cfg); }); });
        } else pushBar5(pos.intraday, bar);
      }
      cur = bend; pos.cursorSec = cur;
    }
    clearUnresolved(P, pos, capture);
    pos.hDone = 1; pos.cursorSec = dayEnd;
    return 'done';
  }
  function positionPhase(P, ctx, capture, cfg) {
    var pos = P.position, H = cfg.horizonHoldingDays, guard = 0;
    if (!pos) return;
    if (pos.hDone === 0) { var pi = positionIntraday(P, ctx, capture, cfg); if (pi !== 'done') return; }
    while (pos.hDone < H && twinsOpen(P) && guard++ < 64) {
      var h = pos.hDone + 1, id = P.entry.fill.dayId + (h - 1) * DAY, bar = ctx.daily[id];
      if (!bar) { pos.stalledAt = { holdingDay: h, barId: id, captureId: capture.captureId }; return; }   // stall: no exit is adjudicated past an unusable bar
      pos.stalledAt = null;
      pos.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      var bD = { id: bar.id, span: DAY };
      bothTwins(P, function (tw) { twinBar(P, tw, bar, h === H).forEach(function (x) { exec(P, tw, x, bD, capture, h, cfg); }); });
      pos.hDone = h;
    }
  }

  // ---------- 1e adjudicatePair ----------
  // evidence: { capture:{captureId,date,inputCutoffSec,issueSec}, candles:[daily usable at the capture], bars5:[5-minute bars], trades:[slices] }. Returns { pair (new object), needs:[{kind,cgId,pair,fromSec,toSec}] }.
  function adjudicatePair(pair, evidence, cfg) {
    var P = clone(pair), ctx = makeCtx(evidence || {}, cfg), capture = ctx.cap;
    if (!capture || !num(capture.inputCutoffSec)) throw new Error('adjudicatePair: evidence.capture.inputCutoffSec required');
    if (entryPending(P)) adjudicateEntry(P, ctx, capture, cfg);
    else if (P.entry.fill && twinsOpen(P)) positionPhase(P, ctx, capture, cfg);
    P.status = statusOf(P);
    return { pair: P, needs: ctx.needs };
  }
  function statusOf(P) {
    if (entryTerminal(P)) return 'terminal-unfilled';
    if (entryPending(P)) return P.entry.status === 'pending-unresolved' ? 'unresolved' : 'pending';
    if (P.position && P.position.unresolved) return 'unresolved';
    return twinsOpen(P) ? 'open' : 'terminal';
  }

  // ---------- 1f pairResult ----------
  function twinPnl(P, tw) {
    var f = P.entry.fill; if (!f || !tw.closed) return null;
    var s = 0; tw.exits.forEach(function (x) { s += x.notionalCents - x.feeCents - x.frictionCents; });
    return s - (f.notionalCents + f.feeCents + f.frictionCents);
  }
  function pairResult(pair) {
    var P = pair, st = statusOf(P), B = P.geometry.Bcents, pT = twinPnl(P, P.twins.T), pL = twinPnl(P, P.twins.L);
    var rT = pT == null ? null : pT / B, rL = pL == null ? null : pL / B, delta = (rT == null || rL == null) ? null : rL - rT;
    var affected = P.twins.L.exits.some(function (x) { return x.rungK != null; });
    return { pairId: P.pairId, cgId: P.cgId, status: st, filled: !!P.entry.fill, terminal: st === 'terminal' || st === 'terminal-unfilled', netPnL_T: pT, netPnL_L: pL, R_T: rT, R_L: rL, delta: delta, Bcents: B,
      flags: { unresolved: st === 'unresolved', fallbackTonly: !!(P.plan && P.plan.tOnly), affected: affected, studied: !!P.study }, fallbackReason: P.plan ? P.plan.fallbackReason : null,
      exits: { T: P.twins.T.exits.map(function (x) { return x.reason; }), L: P.twins.L.exits.map(function (x) { return x.reason; }) } };
  }

  return { VERSION: VERSION, SCHEMA: SCHEMA, GATES: GATES, ALL_GATES: ALL_GATES, FALLBACKS: FALLBACKS, DAY: DAY, BAR5: BAR5,
    validateConfig: validateConfig, isStudy: isStudy, chargesOf: chargesOf, gateStates: gateStates,
    eligibility: eligibility, orderGeometry: orderGeometry, ladderPlan: ladderPlan, rearm: rearm, controllerAfterPair: controllerAfterPair, newPair: newPair, isActive: isActive, statusOf: statusOf,
    adjudicatePair: adjudicatePair, pairResult: pairResult, twinBar: twinBar, twinTrades: twinTrades };
});
