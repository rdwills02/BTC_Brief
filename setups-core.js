/* setups-core.js — Step 11-C (Remediation spec H5, frozen signals), schemaVersion 2 (Forward pipeline repair, 2026-09-25: the ledger
 * carries its own post-issue daily bars). Pure ledger logic for data/setups.json: no fs, no Date, no globals.
 * capture.js does the I/O around updateSetupLedger(); the runner replays the dated fixtures through it and scores the live ledger from
 * record.bars alone. FORWARD EVIDENCE = data/setups.json bars only.
 *
 * Ledger shape (stable key order, setups sorted by id, so diffs stay readable):
 *   { schemaVersion: 2, setups: [ record, ... ] }
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
 *   state         'ACT' (the only value this build writes; 'NEAR' is reserved for a later extension)
 *   failedGates   [] for ACT; reserved for the NEAR extension
 *   openBarId     id (unix open time) of the last CLOSED daily candle strictly before openedAt - the bar the ACT fit was judged on; null if unknown
 *   unscorable    null, or 'no-open-bar' when openBarId is unknown (v1 migration without a cache bar, or none at open); the runner skips these
 *   bars          [{id, date, open, high, low, close[, entryDay: true]}] closed daily candles from openedAt on, candle order, APPEND-ONLY (never modified/removed);
 *                 the candle dated openedAt carries entryDay: true (Amendment 1: it holds the entry and the ~19h after it)
 *   lastBarId     id of the last appended bar (null until the first)
 *   barSource     {venue, pair} of the first appended bar (null until then); a later bar from another venue/pair is refused
 *   barSourceMismatches  count of distinct bars refused for a venue/pair mismatch; lastMismatchBarId = highest such id (keeps the count idempotent)
 *   breachBarIds  [id,...] bars whose close was below the invalidation in force when the bar was appended; consecutiveBreachBars(record)
 *                 is computed from the tail of bars (not stored)
 *   closedAt, closeReason ("broken" | "left-universe") — null while open
 * Append rule (per open OR recently closed record): a bar is appended only if isClosed === true, id > lastBarId, date >= openedAt, all OHLC
 * finite, and venue/pair match barSource. (date >= openedAt, Amendment 1.) After a close, bars stop at close + SETUP_POST_CLOSE_BARS bars (dated after closedAt).
 * Rules (H5, C-1 review ruling): open on the first research ACT for a (cgId, timeframe) with no open setup; close 'broken' when
 * SETUP_BREAK_CLOSES consecutive daily closes sit below the invalidation (closedAt = the date of the bar that completes the run), or
 * 'left-universe' when the coin is absent from the capture; a closed id never reopens; a later ACT after a close opens a NEW id (dated
 * that capture); records are never deleted; same-day re-run is idempotent (bars, counters unchanged).
 * v1 -> v2: normalizeLedger back-fills bars: [], state 'ACT', failedGates [], and openBarId from barsByCoin when the candle exists.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SetupsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var SETUPS_SCHEMA_VERSION = 2;
  var SETUP_BREAK_CLOSES = 3;   // PROVISIONAL (Ruling b, 2026-09-25; A1): consecutive DAILY CLOSES (bars, not capture quotes) below the invalidation that close a setup. In capture.js's configHash.
  var SETUP_POST_CLOSE_BARS = 20;   // bars keep appending after a close up to close + 20 (the longest scoring horizon); open records have no cap

  function num(v) { return typeof v === 'number' && isFinite(v); }
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function cleanBar(b) { var o = { id: b.id, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close }; if (b.entryDay === true) o.entryDay = true; return o; }
  function validBar(b) { return b && num(b.id) && typeof b.date === 'string' && DATE_RE.test(b.date) && num(b.open) && num(b.high) && num(b.low) && num(b.close); }
  function makeRecord(r) {
    // fixed key order
    return {
      id: r.id, status: r.status, openedAt: r.openedAt, openPrice: (typeof r.openPrice === 'number' && isFinite(r.openPrice)) ? r.openPrice : null, lastSeenAt: r.lastSeenAt, cgId: r.cgId, timeframe: r.timeframe,
      entryZone: r.entryZone, entryRef: r.entryRef, supSlope: r.supSlope, supIntercept: r.supIntercept, supportNow: r.supportNow,
      anchorIds: r.anchorIds.slice(), invalidation: r.invalidation, invalidationRaises: r.invalidationRaises, raisesSuppressed: r.raisesSuppressed,
      liveInvalidation: r.liveInvalidation, liveFitId: r.liveFitId, liveLifecycleState: r.liveLifecycleState,
      stop: r.stop, target: r.target, netRR: r.netRR, fitId: r.fitId, detectorVersion: r.detectorVersion, configHash: r.configHash,
      state: r.state || 'ACT', failedGates: Array.isArray(r.failedGates) ? r.failedGates.slice() : [],
      openBarId: num(r.openBarId) ? r.openBarId : null, unscorable: r.unscorable || null,
      bars: (r.bars || []).map(cleanBar), lastBarId: num(r.lastBarId) ? r.lastBarId : null,
      barSource: r.barSource ? { venue: r.barSource.venue, pair: r.barSource.pair } : null,
      barSourceMismatches: num(r.barSourceMismatches) ? r.barSourceMismatches : 0, lastMismatchBarId: num(r.lastMismatchBarId) ? r.lastMismatchBarId : null,
      breachBarIds: (r.breachBarIds || []).slice(), closedAt: r.closedAt, closeReason: r.closeReason
    };
  }
  function emptyLedger() { return { schemaVersion: SETUPS_SCHEMA_VERSION, setups: [] }; }
  // The last CLOSED candle strictly before the open date (the bar the ACT fit was judged on). barList: [{id, date, isClosed, ...}].
  function openBarIdFrom(barList, openedAt) {
    var best = null;
    (barList || []).forEach(function (b) { if (b && b.isClosed === true && num(b.id) && typeof b.date === 'string' && b.date < openedAt && (best === null || b.id > best)) best = b.id; });
    return best;
  }
  // barsByCoin (optional): only used to back-fill openBarId on records that lack it (v1 migration / open-time gap).
  function normalizeLedger(ledger, barsByCoin) {
    var out = emptyLedger();
    if (ledger && Array.isArray(ledger.setups)) {
      for (var i = 0; i < ledger.setups.length; i++) {
        var s = ledger.setups[i];
        if (!s || typeof s.id !== 'string') continue;
        var openBarId = num(s.openBarId) ? s.openBarId : null, unscorable = s.unscorable || null;
        if (openBarId === null && s.openedAt) {
          var back = openBarIdFrom(barsByCoin && barsByCoin[s.cgId], s.openedAt);
          if (back !== null) { openBarId = back; unscorable = null; } else unscorable = 'no-open-bar';
        }
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
          state: s.state === 'NEAR' ? 'NEAR' : 'ACT', failedGates: Array.isArray(s.failedGates) ? s.failedGates : [],
          openBarId: openBarId, unscorable: unscorable,
          bars: Array.isArray(s.bars) ? s.bars.filter(validBar) : [], lastBarId: num(s.lastBarId) ? s.lastBarId : null,
          barSource: s.barSource && typeof s.barSource === 'object' ? s.barSource : null,
          barSourceMismatches: num(s.barSourceMismatches) ? s.barSourceMismatches : 0, lastMismatchBarId: num(s.lastMismatchBarId) ? s.lastMismatchBarId : null,
          breachBarIds: Array.isArray(s.breachBarIds) ? s.breachBarIds.filter(num) : [],
          closedAt: s.closedAt || null, closeReason: s.closeReason || null
        }));
      }
    }
    out.setups.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }

  // Trailing run of bars whose id is in breachBarIds (computed, not stored).
  function consecutiveBreachBars(rec) {
    var set = {}; (rec.breachBarIds || []).forEach(function (id) { set[id] = true; });
    var n = 0;
    for (var i = rec.bars.length - 1; i >= 0 && set[rec.bars[i].id]; i--) n++;
    return n;
  }
  // Append this coin's new closed bars to one record (mutates rec - a private copy from normalizeLedger). Never touches an existing bar.
  function appendBars(rec, coinBars) {
    if (!Array.isArray(coinBars) || !coinBars.length) return;
    var list = coinBars.filter(function (b) { return b && num(b.id); }).sort(function (a, b) { return a.id - b.id; });
    list.forEach(function (b) {
      if (b.isClosed !== true || !validBar(b)) return;
      if (rec.lastBarId !== null && b.id <= rec.lastBarId) return;      // duplicate / older / out of order
      if (b.date < rec.openedAt) return;                                // before the open date (a bar dated openedAt is the entry-day bar: stored, flagged entryDay)
      if (rec.status === 'closed' && rec.closedAt) {                    // post-close cap: close + SETUP_POST_CLOSE_BARS bars
        var after = 0; rec.bars.forEach(function (x) { if (x.date > rec.closedAt) after++; });
        if (after >= SETUP_POST_CLOSE_BARS) return;
      }
      var src = { venue: b.venue === undefined ? null : b.venue, pair: b.pair === undefined ? null : b.pair };
      if (rec.barSource && (rec.barSource.venue !== src.venue || rec.barSource.pair !== src.pair)) {
        if (rec.lastMismatchBarId === null || b.id > rec.lastMismatchBarId) { rec.barSourceMismatches++; rec.lastMismatchBarId = b.id; }
        return;
      }
      if (!rec.barSource) rec.barSource = src;
      rec.bars.push(cleanBar(Object.assign({}, b, { entryDay: b.date === rec.openedAt }))); rec.lastBarId = b.id;
      if (rec.status === 'open' && num(rec.invalidation)) {
        if (b.close < rec.invalidation) rec.breachBarIds.push(b.id);
        if (consecutiveBreachBars(rec) >= SETUP_BREAK_CLOSES) { rec.status = 'closed'; rec.closedAt = b.date; rec.closeReason = 'broken'; }
      }
    });
  }

  // rows: one per coin in TODAY's universe (whether or not it has a research fit):
  //   { cgId, timeframe, verdict ('ACT'|'WATCH'|'WAIT'|'NONE'|null), lifecycleState|null, price|null,
  //     fit: { fitId, pivotIds, supSlope, supIntercept, supportNow, invalidation, entryEconomics:{entryZone, entryRef, stop, target, netRR} } | null }
  // meta: { detectorVersion, configHash, barsByCoin: { cgId: [{id, date, open, high, low, close, venue, pair, isClosed}] } }.
  // Returns a NEW normalized ledger; the input is not mutated.
  function updateSetupLedger(ledger, today, rows, meta) {
    meta = meta || {};
    var barsByCoin = meta.barsByCoin || {};
    var L = normalizeLedger(ledger, barsByCoin);
    var byId = {}; L.setups.forEach(function (s) { byId[s.id] = s; });
    var present = {}; (rows || []).forEach(function (r) { if (r && r.cgId) present[r.cgId + ':' + (r.timeframe || '1d')] = r; });
    function openFor(key) { for (var i = 0; i < L.setups.length; i++) { var s = L.setups[i]; if (s.status === 'open' && s.cgId + ':' + s.timeframe === key) return s; } return null; }

    // 1. every record: same-rail raise (open only), append this coin's new closed bars, then close 'broken' on SETUP_BREAK_CLOSES consecutive
    //    daily closes below the invalidation (inside appendBars), or 'left-universe' when the coin is absent. The live lifecycle is recorded, never acted on.
    L.setups.forEach(function (s) {
      var key = s.cgId + ':' + s.timeframe, r = present[key];
      if (s.status === 'open' && r && r.fit) {
        var fit = r.fit;
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
      appendBars(s, barsByCoin[s.cgId]);
      if (s.status === 'open' && !r) { s.status = 'closed'; s.closedAt = today; s.closeReason = 'left-universe'; }
    });

    // 2. new ACTs open a setup when none is open for (cgId, timeframe); a closed id never reopens
    (rows || []).forEach(function (r) {
      if (!r || r.verdict !== 'ACT' || !r.fit) return;
      var tf = r.timeframe || '1d', key = r.cgId + ':' + tf;
      if (openFor(key)) return;
      var id = key + ':' + today;
      if (byId[id]) return; // same-day re-run after a same-day open+close: idempotent, never reopen
      var ee = r.fit.entryEconomics || {};
      var obid = openBarIdFrom(barsByCoin[r.cgId], today);
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
        state: 'ACT', failedGates: [], openBarId: obid, unscorable: obid === null ? 'no-open-bar' : null,
        bars: [], lastBarId: null, barSource: null, barSourceMismatches: 0, lastMismatchBarId: null, breachBarIds: [], closedAt: null, closeReason: null
      });
      L.setups.push(rec); byId[id] = rec;
    });
    L.setups.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return L;
  }

  // Compact per-coin research block for latest-daily.json (capture.js) — display/ledger summary, never a fit.
  function researchSummary(fit, res) {
    if (!res) return null;
    var ee = fit && fit.entryEconomics, xc = fit && fit.executionContext;
    var gs = res.details && Array.isArray(res.details.gates) ? res.details.gates : null;   // Gate log (2026-09-25 spec Part A): per-gate measurements as evaluated
    var out = {
      verdict: res.verdict, gate: res.gate, reason: res.reason,
      score: fit && num(fit.score) ? fit.score : null, fitId: fit ? (fit.fitId || null) : null,
      lifecycleState: fit ? (fit.lifecycleState || null) : null,
      entryEconomics: ee ? { entryRef: num(ee.entryRef) ? ee.entryRef : null, stop: num(ee.stop) ? ee.stop : null, target: num(ee.target) ? ee.target : null, netRR: num(ee.netRR) ? ee.netRR : null } : null,
      executionContext: xc ? { volumeCharacter: xc.volumeCharacter || 'unknown', volumeRatio: num(xc.volumeRatio) ? xc.volumeRatio : null } : null   // Step 11-D (H10): descriptive, compact
    };
    // gates: [{id, pass, value, threshold}] - value/threshold exactly as evaluated (no rounding), channel-core order; ABSENT (not []) when res has no details.
    if (gs) out.gates = gs.map(function (g) { return { id: g.id, pass: g.pass, value: g.value === undefined ? null : g.value, threshold: g.threshold === undefined ? null : g.threshold }; });
    return out;
  }

  return { SETUPS_SCHEMA_VERSION: SETUPS_SCHEMA_VERSION, SETUP_BREAK_CLOSES: SETUP_BREAK_CLOSES, SETUP_POST_CLOSE_BARS: SETUP_POST_CLOSE_BARS, consecutiveBreachBars: consecutiveBreachBars, openBarIdFrom: openBarIdFrom, emptyLedger: emptyLedger, normalizeLedger: normalizeLedger, updateSetupLedger: updateSetupLedger, researchSummary: researchSummary, makeRecord: makeRecord };
});
