/* radar_tools/book/sellzone-core.js — item 52e B: sell-zone core. Pure functions (no fetch, no clock, no I/O). Depends on book-core.js (grid reconstruction by version).
 * Purpose: candidate sell zones on the path E -> T in ABSOLUTE PRICES from retained ask bins; Q (zone quote mass), C (local concentration), M (activity-relative mass); hourly activity baseline.
 * Design authority: Astra Critical-Mass Sell-Zone Overlay Proposal + Data Dependencies Review (2026-10-14). Where this file and the 52e cold-start differ, the Astra documents win.
 * DECLARED CONVENTIONS (exploratory; no cutoff here is a finding)
 *  - Path = (E, T]. Coverage is always a comparison of ABSOLUTE prices: E, T, finite grid top, farthest returned ask, snapshot midpoint is only reported. Never "% above entry" vs "% above anchor/mid".
 *  - A bin that straddles E or T is `approx`: its in-path allocation is unknown, so zone mass carries bounds [Qlo, Qhi] (zero vs full bin) and Q itself is null; the full bin is never assumed in-path.
 *  - Density = bin quote / bin width in price units (quote per unit price). Baselines are taken over covered comparison bins inside a neighborhood declared in PRICE UNITS (params give a price or a percent of E, resolved per call).
 *    Empty covered bins count as zero density. A zero or unobservable baseline is "unavailable", never an infinite ratio or a pass.
 *  - Clustering: seed = path bin with density >= c0 x local baseline (that bin excluded); eligible = density >= c1 x baseline; eligible bins chain left to right while the price gap <= maxGapPrice and the chain width <= maxZoneWidth;
 *    a chain is a candidate zone only if it holds a seed. Zone mass counts ALL ask bins inside the zone's price range (gap bins included). Greedy and deterministic.
 *  - C(zone) = zone density (full bins) / baseline density of comparable bins in [zone - nb, zone + nb] with the zone excluded; unavailable unless that neighborhood is covered (grid AND book).
 *  - M(zone) = Q / median hourly quote turnover (same venue/pair, 168 complete UTC hours in [H-168h, H)); bounds from the baseline bounds and Q bounds. materiality: pass | fail | uncertain (bounds straddle the cutoff) | unavailable.
 *  - Cutoffs are PARAMETERS. `calibrationCandidates` is a labelled list of values to inspect, not a recommendation. */
(function (root, factory) { if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./book-core.js')); else root.SellzoneCore = factory(root.BookCore); })(typeof self !== 'undefined' ? self : this, function (B) {
  'use strict';
  var VERSION = 'sellzone-core/1', HOUR = 3600000, WINDOW_HOURS = 168, MIN_VALID_HOURS = 120;
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function sig(x) { return num(x) ? Number(x.toPrecision(10)) : x; }
  function median(a) { var x = a.slice().sort(function (p, q) { return p - q; }), n = x.length; if (!n) return null; return n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2; }
  function asGrid(record, grid) {
    var g = typeof grid === 'string' ? B.gridOf(grid) : grid; if (!g || !g.edges) throw new Error('unknown grid');
    if (record && record.grid && B.gridId(g) !== record.grid) throw new Error('grid-mismatch: ' + B.gridId(g) + ' vs record ' + record.grid);
    return g;
  }
  // ---------- B1 coverage (absolute prices) ----------
  // Interval [lo, hi] of the ask book. gridCoveredTo = finite upper grid edge; bookCoveredTo = farthest returned ask when the source book was cap-limited (null when the source returned the full book).
  function ivCov(record, g, lo, hi) {
    var e = g.edges, gridTop = e[e.length - 1], capA = !!(record.capReached && record.capReached.a), far = record.farthest ? record.farthest.a : null;
    var bookCoveredTo = capA ? (far != null ? far : (record.bestAsk != null ? record.bestAsk : null)) : null, coveredTo = capA ? Math.min(gridTop, bookCoveredTo == null ? -Infinity : bookCoveredTo) : gridTop;
    var ep = 1e-9 * Math.abs(hi), gridShort = hi > gridTop + ep, bookShort = capA && (bookCoveredTo == null || hi > bookCoveredTo + ep), tail = 0;   // edges are computed as anchor x (1 + bp/10000): compare with a relative 1e-9 tolerance so T on an edge is not off by one ulp
    ((record.bins && record.bins.a) || []).forEach(function (x) { if (x[0] === e.length) tail += x[2]; });
    return { pathLo: lo, pathHi: hi, gridId: B.gridId(g), gridAnchor: g.anchor, gridCoveredTo: gridTop, bookComplete: !capA, bookCoveredTo: bookCoveredTo, coveredTo: coveredTo, midpoint: record.mid == null ? null : record.mid, farthestAsk: far, capReached: capA,
      status: gridShort && bookShort ? 'both' : gridShort ? 'gridLimited' : bookShort ? 'sourceLimited' : 'complete', tailMassBeyondGrid: sig(tail) };
  }
  function coverage(record, grid, E, T) { return ivCov(record, asGrid(record, grid), E, T); }

  // ---------- parameters ----------
  function resolveParams(p, E) {
    function pu(price, pct) { return num(price) ? price : (num(pct) ? pct / 100 * E : null); }
    var r = { c0: p.seedMinConcentration, c1: p.extendMinConcentration, maxGapPrice: pu(p.maxGapPrice, p.maxGapPct), maxZoneWidthPrice: pu(p.maxZoneWidthPrice, p.maxZoneWidthPct), neighborhoodPrice: pu(p.neighborhoodPrice, p.neighborhoodPct), baselineMethod: p.baselineMethod || 'median' };
    ['c0', 'c1', 'maxGapPrice', 'maxZoneWidthPrice', 'neighborhoodPrice'].forEach(function (k) { if (!num(r[k]) || r[k] < 0) throw new Error('param ' + k + ' missing or invalid'); });
    if (r.baselineMethod !== 'median' && r.baselineMethod !== 'mean') throw new Error('baselineMethod must be median or mean'); if (r.c1 > r.c0) throw new Error('extendMinConcentration must be <= seedMinConcentration');
    return r;
  }
  // ---------- bins ----------
  function askMap(record) { var m = {}; ((record.bins && record.bins.a) || []).forEach(function (x) { m[x[0]] = { idx: x[0], base: x[1], quote: x[2] }; }); return m; }
  function startLo(record, g) {   // lower edge of the bin holding the best ask: nothing below the book start is a comparable interval
    var e = g.edges; if (record.bestAsk == null) return e[0]; var i = B.binIndex(g, record.bestAsk); return i < 1 ? e[0] : i >= e.length ? e[e.length - 1] : e[i - 1];
  }
  // Baseline density over covered finite bins whose centre lies in [centre-lo - nb, centre-hi + nb], excluding bins overlapping [exLo, exHi]. Unavailable unless the whole neighborhood is covered.
  function nbBaseline(g, map, cov, sLo, exLo, exHi, nb, method) {
    var e = g.edges, nbLo = Math.max(exLo - nb, sLo), nbHi = exHi + nb;
    if (nbHi > cov.coveredTo) return { available: false, reason: 'neighborhood-not-covered', nbLo: sig(nbLo), nbHi: sig(nbHi), coveredTo: sig(cov.coveredTo) };
    var dens = [], q = 0, w = 0, i, lo, hi, c;
    for (i = 1; i < e.length; i++) { lo = e[i - 1]; hi = e[i]; c = (lo + hi) / 2; if (c < nbLo || c > nbHi) continue; if (hi > exLo && lo < exHi) continue; var x = map[i], qq = x ? x.quote : 0; dens.push(qq / (hi - lo)); q += qq; w += hi - lo; }
    if (!dens.length) return { available: false, reason: 'no-comparable-intervals', nbLo: sig(nbLo), nbHi: sig(nbHi) };
    var b = method === 'mean' ? q / w : median(dens);
    if (!(b > 0)) return { available: false, reason: 'zero-baseline', nbLo: sig(nbLo), nbHi: sig(nbHi), nBins: dens.length };
    return { available: true, value: b, method: method, nbLo: sig(nbLo), nbHi: sig(nbHi), nBins: dens.length };
  }
  // ---------- B2 / B3 candidate zones with Q and C ----------
  function candidateZones(record, grid, E, T, params) {
    var g = asGrid(record, grid), P = resolveParams(params, E), cov = ivCov(record, g, E, T), map = askMap(record), sLo = startLo(record, g), e = g.edges, eps = 1e-9 * E, bins = [], unassessed = [], i;
    for (i = 1; i < e.length; i++) {
      var lo = e[i - 1], hi = e[i], x = map[i]; if (hi <= E + eps || lo >= T - eps) continue;   // path = (E, T]
      if (!x || !(x.quote > 0)) continue;
      var bn = { idx: i, lo: lo, hi: hi, quote: x.quote, density: x.quote / (hi - lo), boundary: (lo < E - eps ? 'E' : '') + (hi > T + eps ? 'T' : '') || null, seed: false, eligible: false };
      if (hi > cov.coveredTo) { unassessed.push({ idx: i, lo: lo, hi: hi, reason: 'bin-beyond-coverage' }); continue; }
      var nb = nbBaseline(g, map, cov, sLo, lo, hi, P.neighborhoodPrice, P.baselineMethod);
      if (!nb.available) { unassessed.push({ idx: i, lo: lo, hi: hi, reason: nb.reason }); continue; }
      bn.ratio = bn.density / nb.value; bn.eligible = bn.ratio >= P.c1; bn.seed = bn.ratio >= P.c0; bins.push(bn);
    }
    var chains = [], cur = null;
    bins.filter(function (b) { return b.eligible; }).forEach(function (b) {
      if (cur && b.lo - cur.hi <= P.maxGapPrice + eps && b.hi - cur.lo <= P.maxZoneWidthPrice + eps) { cur.members.push(b); cur.hi = b.hi; } else { cur = { lo: b.lo, hi: b.hi, members: [b] }; chains.push(cur); }
    });
    var zones = chains.filter(function (c) { return c.members.some(function (b) { return b.seed; }); }).map(function (c) {
      var zb = [], qLoSum = 0, qApprox = 0, full = 0, aE = false, aT = false;
      for (var k = 1; k < e.length; k++) {
        var l2 = e[k - 1], h2 = e[k], y = map[k]; if (h2 <= c.lo + eps || l2 >= c.hi - eps || h2 <= E + eps || l2 >= T - eps || !y || !(y.quote > 0)) continue;
        var bd = (l2 < E - eps ? 'E' : '') + (h2 > T + eps ? 'T' : '') || null, mem = c.members.filter(function (m) { return m.idx === k; })[0];
        zb.push({ idx: k, lo: sig(l2), hi: sig(h2), quote: sig(y.quote), boundary: bd, seed: !!(mem && mem.seed), member: !!mem }); full += y.quote;
        if (bd) { qApprox += y.quote; if (bd.indexOf('E') >= 0) aE = true; if (bd.indexOf('T') >= 0) aT = true; } else qLoSum += y.quote;
      }
      var width = c.hi - c.lo, density = full / width, nb2 = nbBaseline(g, map, cov, sLo, c.lo, c.hi, P.neighborhoodPrice, P.baselineMethod), approx = qApprox > 0;
      var z = { id: sig(c.lo) + '-' + sig(c.hi), lo: sig(c.lo), hi: sig(c.hi), widthPrice: sig(width), widthPctOfE: sig(width / E * 100), bins: zb, approx: { E: aE, T: aT }, Qlo: sig(qLoSum), Qhi: sig(qLoSum + qApprox), Q: approx ? null : sig(qLoSum), quoteFullBins: sig(full), density: sig(density),
        pctAboveEntry: { lo: sig((c.lo - E) / E * 100), hi: sig((c.hi - E) / E * 100), reference: 'E' }, baseline: nb2.available ? { value: sig(nb2.value), method: nb2.method, nbLo: nb2.nbLo, nbHi: nb2.nbHi, nBins: nb2.nBins } : { available: false, reason: nb2.reason, nbLo: nb2.nbLo, nbHi: nb2.nbHi } };
      z.C = nb2.available ? sig(density / nb2.value) : null; z.CStatus = nb2.available ? 'ok' : 'unavailable'; z.CReason = nb2.available ? null : nb2.reason; z.CBasis = approx ? 'full boundary bins (approx)' : 'exact';
      return z;
    });
    return { zones: zones, unassessed: unassessed, coverage: cov, params: P, seeds: bins.filter(function (b) { return b.seed; }).length, pathBins: bins.length };
  }

  // ---------- B4 activity baseline ----------
  // rows: Kraken OHLC rows [time(s), open, high, low, close, vwap, volume, count] (the `last` field is NOT a row);  Coinbase candles [time(s), low, high, open, close, volume].
  function normCandle(venue, r) {
    var t = Number(r[0]) * 1000;
    if (venue === 'kraken') return { t: t, o: +r[1], h: +r[2], l: +r[3], c: +r[4], vwap: +r[5], vol: +r[6] };
    return { t: t, l: +r[1], h: +r[2], o: +r[3], c: +r[4], vol: +r[5] };
  }
  function activityBaseline(candles, venue, H) {
    if (venue !== 'kraken' && venue !== 'coinbase') throw new Error('venue must be kraken or coinbase');
    var Hms = typeof H === 'string' ? Date.parse(H) : H; if (!num(Hms) || Hms % HOUR !== 0) throw new Error('H must be the start of a UTC hour');
    var start = Hms - WINDOW_HOURS * HOUR, seen = {}, dupConflicts = 0, outside = 0, malformed = 0, byHour = {};
    (candles || []).forEach(function (r) {
      var c = normCandle(venue, r); if (!num(c.t)) { malformed++; return; }
      if (c.t < start || c.t >= Hms || (c.t - start) % HOUR !== 0) { outside++; return; }   // clip: only whole hours ending no later than H (running hour excluded)
      var sigStr = JSON.stringify(c); if (seen[c.t] != null) { if (seen[c.t] !== sigStr) dupConflicts++; return; } seen[c.t] = sigStr;
      var q, lo, hi;
      if (!num(c.vol) || c.vol < 0) { malformed++; return; }
      if (venue === 'kraken') { if (c.vol === 0) { q = 0; lo = 0; hi = 0; } else { if (!(c.vwap > 0)) { malformed++; return; } q = c.vwap * c.vol; lo = hi = q; } }
      else { if (!num(c.c) || !num(c.l) || !num(c.h) || c.c < 0 || c.l < 0 || c.h < 0) { malformed++; return; } q = c.c * c.vol; lo = c.l * c.vol; hi = c.h * c.vol; }
      byHour[c.t] = { t: c.t, quote: q, lo: lo, hi: hi, vol: c.vol };
    });
    var hourly = [], missing = [], k, t;
    for (k = 0; k < WINDOW_HOURS; k++) { t = start + k * HOUR; if (byHour[t]) hourly.push(byHour[t]); else missing.push(t); }
    var out = { venue: venue, hourStartMs: Hms, window: { startMs: start, endMs: Hms, hours: WINDOW_HOURS }, validHours: hourly.length, missingHours: missing, dupConflicts: dupConflicts, clippedOutside: outside, malformed: malformed,
      method: venue === 'kraken' ? 'vwap x base volume (hourly quote turnover)' : 'close x base volume (ESTIMATE of hourly quote turnover; bounds low x volume .. high x volume)', source: venue === 'kraken' ? 'kraken OHLC interval=60' : 'coinbase candles granularity=3600',
      exact: venue === 'kraken', label: venue === 'kraken' ? 'quote turnover' : 'estimate', median: null, medianLo: null, medianHi: null, status: 'unavailable', reason: null, hourly: hourly.map(function (h) { return [h.t, sig(h.quote), sig(h.lo), sig(h.hi)]; }) };
    if (hourly.length < MIN_VALID_HOURS) { out.reason = 'valid hours ' + hourly.length + ' < ' + MIN_VALID_HOURS; return out; }
    var m = median(hourly.map(function (h) { return h.quote; })); if (!(m > 0)) { out.reason = 'zero median'; return out; }
    out.median = sig(m); out.medianLo = sig(median(hourly.map(function (h) { return h.lo; }))); out.medianHi = sig(median(hourly.map(function (h) { return h.hi; })));
    out.status = hourly.length === WINDOW_HOURS ? 'complete' : 'provisional'; out.reason = out.status === 'provisional' ? 'provisional: ' + hourly.length + '/' + WINDOW_HOURS + ' valid hours' : null;
    return out;
  }

  // ---------- staleness: per-pair limit = staleMultiplier x EFFECTIVE scheduled cadence ----------
  // table = cadence.json `table` ([{ venue, pair, tier, cadenceMs, fromMs, toMs|null }], effective-dated). The entry in force at atMs (the time the observation is judged: fromMs <= atMs < toMs) decides.
  // No entry in force -> maxAgeMs null (freshness unknown: sellObstacleZones then withholds the all-clear). staleMultiplier is a labelled parameter, not a finding.
  function staleMaxAgeMs(table, venue, pair, atMs, staleMultiplier) {
    if (!num(staleMultiplier) || !(staleMultiplier > 0)) throw new Error('staleMultiplier must be a positive number');
    var hit = (table || []).filter(function (e) { return e.venue === venue && e.pair === pair && num(e.cadenceMs) && e.fromMs <= atMs && (e.toMs == null || atMs < e.toMs); })[0];
    if (!hit) return { maxAgeMs: null, cadenceMs: null, tier: null, multiplier: staleMultiplier, reason: 'no cadence entry in force at ' + atMs };
    return { maxAgeMs: staleMultiplier * hit.cadenceMs, cadenceMs: hit.cadenceMs, tier: hit.tier || null, multiplier: staleMultiplier, effectiveFromMs: hit.fromMs, reason: null };
  }
  // ---------- B3 M / materiality, B5 assembly ----------
  function baselineOk(b) { return !!(b && b.status !== 'unavailable' && num(b.median) && b.median > 0); }
  function evaluateZone(z, baseline, cutoffs) {
    var cut = cutoffs || {}, ok = baselineOk(baseline), out = {};
    out.M = ok && z.Q != null ? sig(z.Q / baseline.median) : null;
    out.Mlo = ok ? sig(z.Qlo / (num(baseline.medianHi) && baseline.medianHi > 0 ? baseline.medianHi : baseline.median)) : null;
    out.Mhi = ok ? (num(baseline.medianLo) && baseline.medianLo > 0 ? sig(z.Qhi / baseline.medianLo) : null) : null;   // null = unbounded above (low-side baseline is zero)
    out.MhiUnbounded = ok && !(num(baseline.medianLo) && baseline.medianLo > 0);
    if (!ok) out.materiality = 'unavailable'; else if (!num(cut.material)) out.materiality = null;
    else if (out.Mlo >= cut.material) out.materiality = 'pass'; else if (!out.MhiUnbounded && out.Mhi < cut.material) out.materiality = 'fail'; else out.materiality = 'uncertain';
    out.concentration = z.CStatus !== 'ok' ? 'unavailable' : !num(cut.concentration) ? null : z.C >= cut.concentration ? 'pass' : 'fail';
    var a = out.concentration, b = out.materiality;
    out.verdict = (a === 'fail' || b === 'fail') ? 'fail' : (a === 'pass' && b === 'pass') ? 'pass' : (a === 'uncertain' || b === 'uncertain') ? 'uncertain' : (a == null || b == null) ? null : 'unavailable';
    return out;
  }
  function sellObstacleZones(record, grid, E, T, baseline, params, cutoffs) {
    var cut = cutoffs || {}, states = [], res = { version: VERSION, E: E, T: T, cutoffs: cut, zones: [], qualifying: [], states: states };
    if (!(num(E) && num(T) && E > 0 && T > E)) { states.push({ code: 'pathInvalid', text: 'No valid entry < target path.' }); res.coverage = null; res.totalAskMassOnPath = null; return res; }
    if (!record || record.empty || record.excludedFromContinuous || !record.bins) { states.push({ code: 'depthIncomplete', text: 'Depth incomplete before target.', detail: 'record has no continuous depth' }); res.coverage = null; res.totalAskMassOnPath = null; return res; }
    var g = asGrid(record, grid), cz = candidateZones(record, g, E, T, params), cov = cz.coverage, map = askMap(record), e = g.edges, totLo = 0, totHi = 0, k, ep = 1e-9 * E;
    for (k = 1; k < e.length; k++) { var lo = e[k - 1], hi = e[k], x = map[k]; if (hi <= E + ep || lo >= T - ep || !x) continue; totHi += x.quote; if (lo >= E - ep && hi <= T + ep) totLo += x.quote; }
    res.coverage = cov; res.params = cz.params; res.unassessed = cz.unassessed; res.baseline = baseline ? { status: baseline.status, median: baseline.median, medianLo: baseline.medianLo, medianHi: baseline.medianHi, validHours: baseline.validHours, method: baseline.method, label: baseline.label, source: baseline.source, exact: baseline.exact } : null;
    res.totalAskMassOnPath = { Qlo: sig(totLo), Qhi: sig(totHi), lowerBound: cov.status !== 'complete', note: cov.status !== 'complete' ? 'mass beyond ' + sig(cov.coveredTo) + ' is not observed' : null };
    res.zones = cz.zones.map(function (z) { var ev = evaluateZone(z, baseline, cut); return Object.assign({}, z, ev); });
    res.qualifying = res.zones.filter(function (z) { return z.verdict === 'pass'; }).map(function (z) { return z.id; });
    var stale = num(cut.asOfMs) && num(cut.maxAgeMs) && record.recv && (cut.asOfMs - Date.parse(record.recv) > cut.maxAgeMs);
    var freshUnknown = num(cut.asOfMs) && !num(cut.maxAgeMs);
    if (freshUnknown) states.push({ code: 'freshnessUnknown', text: 'Depth freshness cannot be judged: no scheduled cadence available.' });
    if (stale) states.push({ code: 'stale', text: 'Depth observation is stale.', detail: { ageMs: cut.asOfMs - Date.parse(record.recv), maxAgeMs: cut.maxAgeMs } });
    if (cov.status !== 'complete') states.push({ code: 'depthIncomplete', text: 'Depth incomplete before target.', detail: { coveredTo: sig(cov.coveredTo), target: T, limit: cov.status } });
    var ba = baselineOk(baseline); if (!ba) states.push({ code: 'baselineUnavailable', text: 'Materiality not assessed: trading-activity baseline unavailable.', detail: baseline ? baseline.reason : 'no baseline supplied' });
    var pathUnassessed = cz.unassessed.length > 0;
    if (pathUnassessed && cov.status === 'complete') states.push({ code: 'comparisonIncomplete', text: 'Comparison depth incomplete: concentration baseline not observed for part of the path.', detail: { bins: cz.unassessed.length } });
    var open = res.zones.some(function (z) { return z.verdict !== 'fail'; });
    if (!stale && !freshUnknown && cov.status === 'complete' && ba && !pathUnassessed && !open) states.push({ code: 'noSubstantialZone', text: 'No substantial sell zone meets the criteria between entry and target.' });
    return res;
  }
  // Labelled candidate values to INSPECT during calibration. Not findings, not recommendations, not defaults.
  var calibrationCandidates = {
    label: 'CALIBRATION CANDIDATES - values to inspect; no recommendation, no default',
    clustering: [
      { name: 'A', baselineMethod: 'median', neighborhoodPct: 4, seedMinConcentration: 3, extendMinConcentration: 1.5, maxGapPct: 1, maxZoneWidthPct: 5 },
      { name: 'B', baselineMethod: 'median', neighborhoodPct: 4, seedMinConcentration: 5, extendMinConcentration: 2.5, maxGapPct: 1, maxZoneWidthPct: 5 },
      { name: 'C', baselineMethod: 'mean', neighborhoodPct: 8, seedMinConcentration: 3, extendMinConcentration: 1.5, maxGapPct: 1, maxZoneWidthPct: 5 },
      { name: 'D', baselineMethod: 'mean', neighborhoodPct: 8, seedMinConcentration: 5, extendMinConcentration: 2.5, maxGapPct: 1, maxZoneWidthPct: 5 }],
    cutoffs: [
      { name: 'k1', concentration: 2, material: 0.5 }, { name: 'k2', concentration: 2, material: 1 }, { name: 'k3', concentration: 2, material: 2 },
      { name: 'k4', concentration: 4, material: 0.5 }, { name: 'k5', concentration: 4, material: 1 }, { name: 'k6', concentration: 4, material: 2 }],
    staleMultiplier: 1.5   // stale when record age > staleMultiplier x the pair's effective scheduled cadence (cadence.json); labelled parameter, not a finding
  };
  return { VERSION: VERSION, MIN_VALID_HOURS: MIN_VALID_HOURS, WINDOW_HOURS: WINDOW_HOURS, coverage: coverage, candidateZones: candidateZones, activityBaseline: activityBaseline, evaluateZone: evaluateZone, staleMaxAgeMs: staleMaxAgeMs, sellObstacleZones: sellObstacleZones, resolveParams: resolveParams, calibrationCandidates: calibrationCandidates };
});
