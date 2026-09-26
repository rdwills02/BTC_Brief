/* episodes-core.js — Forward Experiment Protocol v1.2 §3 (candidate episodes). Pure: no fs, no Date, no globals, no I/O.
 * capture.js does the I/O; the runner and tests call updateEpisodes() directly. Never receives extra (non-canonical) captures.
 * Runs at pipeline step 6 (§4.0): bar lifecycle -> left-universe / delisted-confirmed -> matching -> K / faded.
 *
 * updateEpisodes(prior, capture, researchRows, barsByCoin, universeIds, orderObligations, cfg) -> { state, episodeDays, obligations, events }
 *
 * INPUT CONTRACT (all times unix seconds; candle id = candle open time; dates 'YYYY-MM-DD' UTC)
 *   prior           null | { schemaVersion: 1, episodes: [...], coinState: {...} }   (never mutated; deep-cloned)
 *   capture         { captureId, issueTimeUtc, inputCutoffUtc, inputCutoffSec, date }   canonical captures only
 *   researchRows    { [cgId]: row } — the coin's WINNING fit at this capture, or absent/null for NOFIT. row:
 *                   { fit: { fitId, pivotIds[], supSlope, supIntercept, supportNow, invalidation, atr14, channelH,
 *                            supportTouches, lifecycleState }, price, gates[], entryEconomics{...as logged incl. stopBasis/targetSource} }
 *                   fit.supSlope/supIntercept are in the detector's index coordinates: y = slope*idx + intercept, idx = position in
 *                   barsByCoin[cgId].candles filtered to id+86400 <= inputCutoffSec (the array the detector saw). capture.js guarantees it.
 *   barsByCoin      { [cgId]: { pair, venueEligible, metadataEligible, candles: [{id,open,high,low,close}] } } — candles USABLE at
 *                   issueTimeUtc (isClosed, endTime <= issueTimeUtc, fetchedAt <= issueTimeUtc), ascending by id, distinct ids.
 *   universeIds     array of cgIds in this capture's universe
 *   orderObligations array of { episodeId, cgId, remainingBars } from orders-core (pending: remaining eligible fill bars; open/unresolved: bars to horizon 20)
 *   cfg             DEFAULT_CFG overrides; cfg.manualDelistings = [{ cgId, listDate }]
 * Episode-day = an episode `matched` at this capture (the opening capture counts). episodeDays[] lists them for D2 with the screen result.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.EpisodesCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var EPISODES_SCHEMA_VERSION = 1;
  var DAY = 86400;
  // Constants (Protocol §3; values recorded under §9). PIVOT_LB mirrors channel-core.js `var PIVOT_LB = 3` — a test asserts equality on the source.
  var DEFAULT_CFG = {
    PIVOT_LB: 3, TEST_ATR_MULT: 0.5, T0_OFFSET: 10, K_FADE: 3, BREAK_CLOSES: 3,
    MAX_WIDTH: 0.40, MIN_SUPPORT_TOUCHES: 3, OBLIGATION_BARS: 20, DATA_UNAVAILABLE_N: 10,
    manualDelistings: []
  };

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function mergeCfg(c) { var o = {}, k; for (k in DEFAULT_CFG) o[k] = DEFAULT_CFG[k]; if (c) for (k in c) if (c[k] !== undefined) o[k] = c[k]; return o; }
  function anchorKey(a) { return a.id + ':' + a.type; }
  function sortAnchors(a) { return a.slice().sort(function (x, y) { return x.id - y.id || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0); }); }

  function anchorsOfFit(fit) {
    var seen = {}, out = [];
    (fit.pivotIds || []).forEach(function (id) { if (num(id) && !seen[id]) { seen[id] = 1; out.push({ id: id, type: 'low' }); } });
    return sortAnchors(out);
  }

  function emptyState() { return { schemaVersion: EPISODES_SCHEMA_VERSION, episodes: [], coinState: {} }; }

  // Candles the detector may use at this capture: usable and endTime <= inputCutoff (open + 86400 <= cutoff).
  function inputCandles(candles, cutoffSec) {
    var out = [];
    for (var i = 0; i < candles.length; i++) if (candles[i].id + DAY <= cutoffSec) out.push(candles[i]);
    return out;
  }

  function delistedAsOf(cfg, cgId, date) {
    var L = cfg.manualDelistings || [];
    for (var i = 0; i < L.length; i++) if (L[i].cgId === cgId && typeof L[i].listDate === 'string' && L[i].listDate <= date) return true;
    return false;
  }

  // §3 Screen: gates opening a new episode and the policy predicate only.
  function screenOf(row, cfg, inUniverse, delisted) {
    var reasons = [], fit = row && row.fit;
    if (!fit) return { pass: false, reasons: ['no-fit'] };
    if (!(fit.lifecycleState === 'intact' || fit.lifecycleState === 're-qualified')) reasons.push('lifecycle');
    var price = row.price;
    if (!num(price) || !(price > 0)) reasons.push('no-price');
    else if (!(num(fit.channelH) && fit.channelH / price <= cfg.MAX_WIDTH)) reasons.push('width');
    if (!(num(fit.supportTouches) && fit.supportTouches >= cfg.MIN_SUPPORT_TOUCHES)) reasons.push('touches');
    if (!inUniverse) reasons.push('not-in-universe');
    if (delisted) reasons.push('delisted-confirmed');
    return { pass: reasons.length === 0, reasons: reasons };
  }

  // PIVOT_LB recount (opening only): usable input candles with open time strictly after the last anchor pivot's candle.
  function pivotLbOk(anchors, inCandles, cfg) {
    if (!anchors.length) return false;
    var last = anchors[anchors.length - 1].id, n = 0;
    for (var i = 0; i < inCandles.length; i++) if (inCandles[i].id > last) n++;
    return n >= cfg.PIVOT_LB;
  }

  // Tests (a) and (b). Returns { a, b, geomPartial, d1, d0 }.
  function runTests(ep, cand, candAnchors, inCandles, cfg) {
    var shared = 0, liveKeys = {}, i;
    (ep.anchorLive || []).forEach(function (a) { liveKeys[anchorKey(a)] = 1; });
    candAnchors.forEach(function (a) { if (liveKeys[anchorKey(a)]) shared++; });
    var a = shared >= 2;
    var idxOf = {}; for (i = 0; i < inCandles.length; i++) idxOf[inCandles[i].id] = i;
    var n = inCandles.length, ref = ep.refLine;
    var res = { a: a, b: false, geomPartial: false, d1: null, d0: null, shared: shared };
    if (!n || !ref || idxOf[ref.originCandleId] === undefined || !num(cand.atr14)) return res;
    var oIdx = idxOf[ref.originCandleId];
    function candAt(k) { return cand.supSlope * k + cand.supIntercept; }
    function refAt(k) { return ref.intercept + ref.slope * (k - oIdx); }
    var tol = cfg.TEST_ATR_MULT * cand.atr14, i1 = n - 1, i0 = n - 1 - cfg.T0_OFFSET;
    res.d1 = Math.abs(candAt(i1) - refAt(i1));
    var candEarliest = candAnchors.length ? candAnchors[0].id : null, refEarliest = num(ref.earliestAnchorId) ? ref.earliestAnchorId : null;
    var partial = (i0 < 0) || (candEarliest != null && inCandles[i0].id < candEarliest) || (refEarliest != null && i0 >= 0 && inCandles[i0].id < refEarliest);
    if (partial) res.geomPartial = true;
    else res.d0 = Math.abs(candAt(i0) - refAt(i0));
    res.b = res.d1 <= tol && (partial || res.d0 <= tol);
    return res;
  }

  function refLineOf(cand, candAnchors, inCandles) {
    var n = inCandles.length, t1 = inCandles[n - 1];
    return { slope: cand.supSlope, intercept: cand.supSlope * (n - 1) + cand.supIntercept, originCandleId: t1.id, t1Id: t1.id,
      earliestAnchorId: candAnchors.length ? candAnchors[0].id : null };
  }

  function unionAnchors(audit, add) {
    var seen = {}, out = [];
    (audit || []).concat(add || []).forEach(function (a) { var k = anchorKey(a); if (!seen[k]) { seen[k] = 1; out.push({ id: a.id, type: a.type }); } });
    return sortAnchors(out);
  }

  function closeEp(ep, reason, capture, events) {
    ep.status = 'closed'; ep.closeReason = reason; ep.closedAt = capture.date; ep.closeCaptureId = capture.captureId; ep.closeCutoffSec = capture.inputCutoffSec;
    ep.obligationCandles = 0;
    events.push({ type: 'closed', episodeId: ep.id, reason: reason, captureId: capture.captureId });
  }

  // Lifecycle from bars (§3): frozen invalidation; counter over newly usable bars in candle order, bars opening >= the opening capture's inputCutoff;
  // a bar arriving after a later-dated bar was counted is appended but ignored by the counter (decisions are final).
  function lifecycle(ep, candles, capture, cfg, events) {
    var have = {}, i, b;
    (ep.bars || []).forEach(function (x) { have[x.id] = 1; });
    for (i = 0; i < candles.length; i++) {
      b = candles[i];
      if (b.id < ep.openCutoffSec || have[b.id]) continue;
      ep.bars.push({ id: b.id, open: b.open, high: b.high, low: b.low, close: b.close });
      have[b.id] = 1;
      if (ep.lastBarId == null || b.id > ep.lastBarId) ep.lastBarId = b.id;
      if (ep.status !== 'open') continue;
      if (ep.lastCountedBarId != null && b.id < ep.lastCountedBarId) continue;   // late bar: ignored for the count
      ep.lastCountedBarId = b.id;
      if (b.close < ep.frozenInvalidation) ep.breakCount++; else ep.breakCount = 0;
      if (ep.breakCount >= cfg.BREAK_CLOSES) { closeEp(ep, 'broken', capture, events); }
    }
  }

  function updateEpisodes(prior, capture, researchRows, barsByCoin, universeIds, orderObligations, cfgIn) {
    var cfg = mergeCfg(cfgIn), state = prior ? clone(prior) : emptyState();
    if (!state.coinState) state.coinState = {};
    researchRows = researchRows || {}; barsByCoin = barsByCoin || {};
    var events = [], episodeDays = [], universe = {}, i;
    (universeIds || []).forEach(function (id) { universe[id] = 1; });

    // Coins to process: every coin with an episode, plus every coin with a research row or bars in this capture.
    var coinSet = {};
    state.episodes.forEach(function (e) { coinSet[e.cgId] = 1; });
    Object.keys(researchRows).forEach(function (c) { coinSet[c] = 1; });
    var coins = Object.keys(coinSet).sort();

    coins.forEach(function (cgId) {
      var meta = barsByCoin[cgId] || {}, allCandles = meta.candles || [];
      var mapped = !!(meta.pair);
      var venueOk = meta.venueEligible !== false && mapped;
      var eps = state.episodes.filter(function (e) { return e.cgId === cgId; });   // stable: openedAt ascending by construction
      // ineligible-venue coins: logged only, no episodes, no coinState.
      if (!venueOk && !eps.length) return;
      var cs = state.coinState[cgId] || (state.coinState[cgId] = { consecutiveNoEval: 0, dataUnavailable: false, pair: meta.pair || null });
      var openEps = function () { return eps.filter(function (e) { return e.status === 'open'; }); };
      var d1Id = capture.inputCutoffSec - DAY, inCandles = inputCandles(allCandles, capture.inputCutoffSec);
      var usableEval = venueOk && inCandles.length > 0 && inCandles[inCandles.length - 1].id === d1Id;
      var inUniverse = !!universe[cgId], delisted = delistedAsOf(cfg, cgId, capture.date);
      var row = researchRows[cgId] || null, fit = row && row.fit ? row.fit : null;

      // data-unavailable flag: 10th consecutive canonical capture with no usable evaluation for a mapped coin. Closes nothing.
      if (mapped) {
        if (usableEval) { cs.consecutiveNoEval = 0; cs.dataUnavailable = false; }
        else { cs.consecutiveNoEval++; if (cs.consecutiveNoEval >= cfg.DATA_UNAVAILABLE_N) cs.dataUnavailable = true; }
      }

      // metadata / venue flags on open episodes
      eps.forEach(function (e) { if (e.status === 'open') { e.venueEligible = venueOk; e.metadataEligible = meta.metadataEligible !== false; e.dataUnavailable = !!cs.dataUnavailable; } });

      // ---- 1. bar lifecycle (usable evaluation only) ----
      if (usableEval) openEps().forEach(function (e) { lifecycle(e, inCandles, capture, cfg, events); });

      // ---- 2. left-universe, delisted-confirmed (also on a data-gap capture) ----
      openEps().forEach(function (e) {
        if (!inUniverse) closeEp(e, 'left-universe', capture, events);
        else if (delisted) closeEp(e, 'delisted-confirmed', capture, events);
      });
      // delisted while still in universe is handled above; delisted while absent from universe already took left-universe.
      if (!inUniverse && delisted) { /* precedence: left-universe first */ }

      // ---- 3. matching ----
      var matched = null, possible = null, opened = null, tests = null, candAnchors = null, screen = null;
      if (!usableEval) {
        openEps().forEach(function (e) {
          e.lastMatchState = 'gap'; e.gapDays = (e.gapDays || 0) + 1;
          e.days.push({ captureId: capture.captureId, date: capture.date, usableEvaluation: false, matchState: 'gap', fitId: null, geometry: null, state: null, price: null, gates: null, entryEconomics: null });
        });
      } else {
        screen = screenOf(row, cfg, inUniverse, delisted);
        if (fit) {
          candAnchors = anchorsOfFit(fit);
          var open = openEps(), firstPossible = null, firstPossibleTests = null;
          for (i = 0; i < open.length && !matched; i++) {
            var t = runTests(open[i], fit, candAnchors, inCandles, cfg);
            if (t.a && t.b) { matched = open[i]; tests = t; }
            else if ((t.a || t.b) && !firstPossible) { firstPossible = open[i]; firstPossibleTests = t; }
          }
          if (!matched && firstPossible) { possible = firstPossible; tests = firstPossibleTests; }
          if (!matched && !possible) {
            // new episode (screen and PIVOT_LB gate opening only)
            if (screen.pass && pivotLbOk(candAnchors, inCandles, cfg)) {
              var pred = eps.length ? eps[eps.length - 1].id : null;   // most recently opened on the coin
              opened = {
                id: 'ep-' + cgId + '-' + capture.date, cgId: cgId, pair: meta.pair, openedAt: capture.date, openCaptureId: capture.captureId,
                openCutoffSec: capture.inputCutoffSec, status: 'open', lastMatchState: 'matched', closeReason: null, closedAt: null,
                closeCaptureId: null, closeCutoffSec: null, predecessorId: pred,
                anchorAudit: candAnchors.slice(), anchorLive: candAnchors.slice(), refLine: refLineOf(fit, candAnchors, inCandles),
                openGeometry: { slope: fit.supSlope, intercept: fit.supIntercept, supportNow: fit.supportNow, atr14: fit.atr14, channelH: fit.channelH, width: (num(row.price) && row.price > 0) ? fit.channelH / row.price : null },
                frozenInvalidation: fit.invalidation, days: [], bars: [], lastBarId: null, lastCountedBarId: null, breakCount: 0,
                K: 0, gapDays: 0, obligationCandles: 0, venueEligible: venueOk, metadataEligible: meta.metadataEligible !== false, dataUnavailable: !!cs.dataUnavailable,
                lastMatchedAt: capture.date
              };
              state.episodes.push(opened); eps.push(opened);
              events.push({ type: 'opened', episodeId: opened.id, captureId: capture.captureId });
              matched = opened; tests = null;
            }
          }
        }
        // per-episode outcomes, K and days
        openEps().forEach(function (e) {
          var isMatched = e === matched, isPossible = e === possible, ms;
          if (isMatched) { ms = 'matched'; e.K = 0; e.lastMatchedAt = capture.date; }
          else if (isPossible) { ms = 'possible-continuation'; }
          else { ms = 'no-match'; e.K++; }
          e.lastMatchState = ms;
          if (isMatched && e !== opened) {
            e.anchorLive = candAnchors.slice(); e.anchorAudit = unionAnchors(e.anchorAudit, candAnchors);
            e.refLine = refLineOf(fit, candAnchors, inCandles);
          }
          var geometry = (isMatched && e !== opened && tests) ? { d1: tests.d1, d0: tests.d0, geomPartial: tests.geomPartial, shared: tests.shared } :
            (isPossible && tests) ? { d1: tests.d1, d0: tests.d0, geomPartial: tests.geomPartial, shared: tests.shared } : null;
          e.days.push({ captureId: capture.captureId, date: capture.date, usableEvaluation: true, matchState: ms, fitId: fit ? fit.fitId : null, geometry: geometry,
            state: fit ? fit.lifecycleState : null, price: row ? row.price : null, gates: row && row.gates ? row.gates : null, entryEconomics: row && row.entryEconomics ? row.entryEconomics : null });
          if (e.K >= cfg.K_FADE) closeEp(e, 'faded', capture, events);
        });
        if (matched) {
          var isOpening = matched === opened;
          episodeDays.push({ episodeId: matched.id, cgId: cgId, pair: matched.pair, captureId: capture.captureId, date: capture.date, opening: isOpening, screen: screen,
            fitId: fit.fitId, venueEligible: venueOk, metadataEligible: meta.metadataEligible !== false, price: row.price, entryEconomics: row.entryEconomics || null,
            score: row.score != null ? row.score : (fit.score != null ? fit.score : null) });
        }
      }
      // pass rows must be recorded on closed-this-capture episodes only as above; non-open episodes get no new day.
    });

    // ---- obligations (recomputed every capture; not a countdown) ----
    var obl = {};
    function bump(cgId, v) { if (v > 0 && (obl[cgId] == null || v > obl[cgId])) obl[cgId] = v; }
    var ordBy = {};
    (orderObligations || []).forEach(function (o) { bump(o.cgId, o.remainingBars); if (o.episodeId) ordBy[o.episodeId] = Math.max(ordBy[o.episodeId] || 0, o.remainingBars || 0); });
    state.episodes.forEach(function (e) {
      var own = 0;
      if (e.status === 'closed') {
        var ids = {}, n = 0, cs2 = (barsByCoin[e.cgId] && barsByCoin[e.cgId].candles) || [];
        for (var j = 0; j < cs2.length; j++) if (cs2[j].id >= e.closeCutoffSec && !ids[cs2[j].id]) { ids[cs2[j].id] = 1; n++; }
        own = Math.max(0, cfg.OBLIGATION_BARS - n);
      }
      e.obligationCandles = Math.max(own, ordBy[e.id] || 0);
      bump(e.cgId, e.obligationCandles);
    });

    state.episodes.sort(function (a, b) { return a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return { state: state, episodeDays: episodeDays, obligations: obl, events: events };
  }

  return { EPISODES_SCHEMA_VERSION: EPISODES_SCHEMA_VERSION, DEFAULT_CFG: DEFAULT_CFG, emptyState: emptyState, updateEpisodes: updateEpisodes,
    screenOf: screenOf, runTests: runTests, anchorsOfFit: anchorsOfFit, inputCandles: inputCandles, pivotLbOk: pivotLbOk };
});
