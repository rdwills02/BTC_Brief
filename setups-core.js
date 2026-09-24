/* setups-core.js — Step 11-C (Remediation spec H5, frozen signals; step 11 plan 11-C; analysis-thread decision
 * "Step 11 Diff C — decision", option (i)). Pure ledger logic for data/setups.json: no fs, no Date, no globals.
 * capture.js does the I/O around updateSetupLedger(); the runner replays the dated fixtures through it.
 *
 * Ledger shape (stable key order, setups sorted by id, so diffs stay readable):
 *   { schemaVersion: 1, setups: [ record, ... ] }
 * Record (key order fixed by makeRecord):
 *   id            "<cgId>:<timeframe>:<first ACT capture date>"
 *   status        "open" | "closed"
 *   openedAt      capture date (YYYY-MM-DD) of the first research ACT
 *   openPrice     the capture quote at open (the row's price the zone gate passed on) - frozen at open, never updated (Step 13-B, ruling f)
 *   lastSeenAt    last capture date the coin had a research fit
 *   cgId, timeframe
 *   entryZone [low, high], entryRef, supSlope, supIntercept, supportNow   — frozen at open
 *   anchorIds     the opening fit's pivotIds (support touch times) - the rail's identity
 *   invalidation  frozen at open; a later capture may RAISE it to the live value ONLY when every anchor id is still in the
 *                 live fit's pivotIds (same rail re-evaluated with newer bars); never lowered; a different pair never raises
 *   invalidationRaises / raisesSuppressed  counts of raises applied / refused for anchor mismatch
 *   liveInvalidation, liveFitId, liveLifecycleState  the last live fit's values, for display only (H5: the live fit evolves separately)
 *   stop, target, netRR, fitId, detectorVersion, configHash                — frozen at open
 *   breachHistory [YYYY-MM-DD, ...]  dates the capture quote closed below the FROZEN invalidation; append-only
 *   consecutiveBreaches  captures in a row with a breach (reset to 0 on a non-breach capture)
 *   closedAt, closeReason ("broken" | "left-universe") — null while open
 * Rules (H5, C-1 review ruling): open on the first research ACT for a (cgId, timeframe) with no open setup; close 'broken'
 * when consecutiveBreaches reaches SETUP_BREAK_CLOSES (judged against the FROZEN rail - the live lifecycle never closes a
 * setup by itself), or 'left-universe' when the coin is absent from the capture; a closed id never reopens; a later ACT
 * after a close opens a NEW id (dated that capture); records are never deleted; same-day re-run is idempotent.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SetupsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var SETUPS_SCHEMA_VERSION = 1;
  var SETUP_BREAK_CLOSES = 3;   // PROVISIONAL (C-1 review ruling 2): consecutive capture quotes below the frozen invalidation that close a setup (A1's rule on the frozen rail). In capture.js's configHash.

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function makeRecord(r) {
    // fixed key order
    return {
      id: r.id, status: r.status, openedAt: r.openedAt, openPrice: (typeof r.openPrice === 'number' && isFinite(r.openPrice)) ? r.openPrice : null, lastSeenAt: r.lastSeenAt, cgId: r.cgId, timeframe: r.timeframe,
      entryZone: r.entryZone, entryRef: r.entryRef, supSlope: r.supSlope, supIntercept: r.supIntercept, supportNow: r.supportNow,
      anchorIds: r.anchorIds.slice(), invalidation: r.invalidation, invalidationRaises: r.invalidationRaises, raisesSuppressed: r.raisesSuppressed,
      liveInvalidation: r.liveInvalidation, liveFitId: r.liveFitId, liveLifecycleState: r.liveLifecycleState,
      stop: r.stop, target: r.target, netRR: r.netRR, fitId: r.fitId, detectorVersion: r.detectorVersion, configHash: r.configHash,
      breachHistory: r.breachHistory.slice(), consecutiveBreaches: r.consecutiveBreaches, closedAt: r.closedAt, closeReason: r.closeReason
    };
  }
  function emptyLedger() { return { schemaVersion: SETUPS_SCHEMA_VERSION, setups: [] }; }
  function normalizeLedger(ledger) {
    var out = emptyLedger();
    if (ledger && Array.isArray(ledger.setups)) {
      for (var i = 0; i < ledger.setups.length; i++) {
        var s = ledger.setups[i];
        if (!s || typeof s.id !== 'string') continue;
        out.setups.push(makeRecord({
          id: s.id, status: s.status === 'closed' ? 'closed' : 'open', openedAt: s.openedAt || null, openPrice: num(s.openPrice) ? s.openPrice : null, lastSeenAt: s.lastSeenAt || null,
          cgId: s.cgId, timeframe: s.timeframe, entryZone: s.entryZone || null, entryRef: num(s.entryRef) ? s.entryRef : null,
          supSlope: num(s.supSlope) ? s.supSlope : null, supIntercept: num(s.supIntercept) ? s.supIntercept : null, supportNow: num(s.supportNow) ? s.supportNow : null,
          anchorIds: Array.isArray(s.anchorIds) ? s.anchorIds.slice() : [],
          invalidation: num(s.invalidation) ? s.invalidation : null, invalidationRaises: num(s.invalidationRaises) ? s.invalidationRaises : 0,
          raisesSuppressed: num(s.raisesSuppressed) ? s.raisesSuppressed : 0,
          liveInvalidation: num(s.liveInvalidation) ? s.liveInvalidation : null, liveFitId: s.liveFitId || null, liveLifecycleState: s.liveLifecycleState || null,
          stop: num(s.stop) ? s.stop : null, target: num(s.target) ? s.target : null, netRR: num(s.netRR) ? s.netRR : null,
          fitId: s.fitId || null, detectorVersion: s.detectorVersion || null, configHash: s.configHash || null,
          breachHistory: Array.isArray(s.breachHistory) ? s.breachHistory.slice() : [], consecutiveBreaches: num(s.consecutiveBreaches) ? s.consecutiveBreaches : 0,
          closedAt: s.closedAt || null, closeReason: s.closeReason || null
        }));
      }
    }
    out.setups.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }

  // rows: one per coin in TODAY's universe (whether or not it has a research fit):
  //   { cgId, timeframe, verdict ('ACT'|'WATCH'|'WAIT'|'NONE'|null), lifecycleState|null, price|null,
  //     fit: { fitId, pivotIds, supSlope, supIntercept, supportNow, invalidation, entryEconomics:{entryZone, entryRef, stop, target, netRR} } | null }
  // meta: { detectorVersion, configHash }. Returns a NEW normalized ledger; the input is not mutated.
  function updateSetupLedger(ledger, today, rows, meta) {
    var L = normalizeLedger(ledger);
    meta = meta || {};
    var byId = {}; L.setups.forEach(function (s) { byId[s.id] = s; });
    var present = {}; (rows || []).forEach(function (r) { if (r && r.cgId) present[r.cgId + ':' + (r.timeframe || '1d')] = r; });
    function openFor(key) { for (var i = 0; i < L.setups.length; i++) { var s = L.setups[i]; if (s.status === 'open' && s.cgId + ':' + s.timeframe === key) return s; } return null; }

    // 1. existing open setups: same-rail raise, breach against the FROZEN invalidation, close on SETUP_BREAK_CLOSES
    //    consecutive breaches or on leaving the universe. The live lifecycle is recorded, never acted on.
    L.setups.forEach(function (s) {
      if (s.status !== 'open') return;
      var key = s.cgId + ':' + s.timeframe, r = present[key];
      if (!r) { s.status = 'closed'; s.closedAt = today; s.closeReason = 'left-universe'; return; }
      var fit = r.fit;
      if (fit) {
        var firstPassToday = s.lastSeenAt !== today;   // same-day re-run: counters must not move twice (idempotence)
        s.lastSeenAt = today;
        s.liveFitId = fit.fitId || null;
        s.liveLifecycleState = r.lifecycleState || null;
        if (num(fit.invalidation)) {
          s.liveInvalidation = fit.invalidation;
          var livePivots = Array.isArray(fit.pivotIds) ? fit.pivotIds : [];
          var sameRail = s.anchorIds.length > 0 && s.anchorIds.every(function (id) { return livePivots.indexOf(id) !== -1; });
          if (!num(s.invalidation)) s.invalidation = fit.invalidation;
          else if (fit.invalidation > s.invalidation) { if (sameRail) { s.invalidation = fit.invalidation; s.invalidationRaises++; } else if (firstPassToday) s.raisesSuppressed++; }
        }
      }
      var breach = num(r.price) && num(s.invalidation) && r.price < s.invalidation;
      if (breach) {
        if (s.breachHistory.indexOf(today) === -1) { s.breachHistory.push(today); s.consecutiveBreaches++; }
      } else if (s.breachHistory.indexOf(today) === -1) s.consecutiveBreaches = 0;
      if (s.consecutiveBreaches >= SETUP_BREAK_CLOSES) { s.status = 'closed'; s.closedAt = today; s.closeReason = 'broken'; }
    });

    // 2. new ACTs open a setup when none is open for (cgId, timeframe); a closed id never reopens
    (rows || []).forEach(function (r) {
      if (!r || r.verdict !== 'ACT' || !r.fit) return;
      var tf = r.timeframe || '1d', key = r.cgId + ':' + tf;
      if (openFor(key)) return;
      var id = key + ':' + today;
      if (byId[id]) return; // same-day re-run after a same-day open+close: idempotent, never reopen
      var ee = r.fit.entryEconomics || {};
      var rec = makeRecord({
        id: id, status: 'open', openedAt: today, openPrice: num(r.price) ? r.price : null, lastSeenAt: today, cgId: r.cgId, timeframe: tf,
        entryZone: Array.isArray(ee.entryZone) ? ee.entryZone.slice() : null, entryRef: num(ee.entryRef) ? ee.entryRef : null,
        supSlope: num(r.fit.supSlope) ? r.fit.supSlope : null, supIntercept: num(r.fit.supIntercept) ? r.fit.supIntercept : null,
        supportNow: num(r.fit.supportNow) ? r.fit.supportNow : null,
        anchorIds: Array.isArray(r.fit.pivotIds) ? r.fit.pivotIds.slice() : [],
        invalidation: num(r.fit.invalidation) ? r.fit.invalidation : null, invalidationRaises: 0, raisesSuppressed: 0,
        liveInvalidation: num(r.fit.invalidation) ? r.fit.invalidation : null, liveFitId: r.fit.fitId || null, liveLifecycleState: r.lifecycleState || null,
        stop: num(ee.stop) ? ee.stop : null, target: num(ee.target) ? ee.target : null, netRR: num(ee.netRR) ? ee.netRR : null,
        fitId: r.fit.fitId || null, detectorVersion: meta.detectorVersion || null, configHash: meta.configHash || null,
        breachHistory: [], consecutiveBreaches: 0, closedAt: null, closeReason: null
      });
      if (num(r.price) && num(rec.invalidation) && r.price < rec.invalidation) { rec.breachHistory.push(today); rec.consecutiveBreaches = 1; }
      L.setups.push(rec); byId[id] = rec;
    });
    L.setups.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return L;
  }

  // Compact per-coin research block for latest-daily.json (capture.js) — display/ledger summary, never a fit.
  function researchSummary(fit, res) {
    if (!res) return null;
    var ee = fit && fit.entryEconomics, xc = fit && fit.executionContext;
    return {
      verdict: res.verdict, gate: res.gate, reason: res.reason,
      score: fit && num(fit.score) ? fit.score : null, fitId: fit ? (fit.fitId || null) : null,
      lifecycleState: fit ? (fit.lifecycleState || null) : null,
      entryEconomics: ee ? { entryRef: num(ee.entryRef) ? ee.entryRef : null, stop: num(ee.stop) ? ee.stop : null, target: num(ee.target) ? ee.target : null, netRR: num(ee.netRR) ? ee.netRR : null } : null,
      executionContext: xc ? { volumeCharacter: xc.volumeCharacter || 'unknown', volumeRatio: num(xc.volumeRatio) ? xc.volumeRatio : null } : null   // Step 11-D (H10): descriptive, compact
    };
  }

  return { SETUPS_SCHEMA_VERSION: SETUPS_SCHEMA_VERSION, SETUP_BREAK_CLOSES: SETUP_BREAK_CLOSES, emptyLedger: emptyLedger, normalizeLedger: normalizeLedger, updateSetupLedger: updateSetupLedger, researchSummary: researchSummary, makeRecord: makeRecord };
});
