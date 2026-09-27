/* radar_tools/replay/replay-driver.js — Historical Walk-Forward Replay Driver (queue item 6).
 *
 * Spec: "Radar Historical Walk-Forward Replay Spec v0 — 2026-09-26" + v0.1 rulings (§8).
 * Context: Radar Forward Experiment Protocol v1.3 §4-7 (execution, accounts, bootstrap);
 * Radar Episodes + Policy Signals Build Spec v1.2 (module contracts).
 *
 * Reuses episodes-core.js and orders-core.js UNMODIFIED via require() — never copied, never
 * re-implemented. channel-core.js is reused the same way for detection + the research verdict
 * (researchVerdict) + BTC regime (btcRegimeFromCandles), exactly the functions capture.js's own
 * forward research pass calls, with different (bar-close, historical) inputs plugged in.
 *
 * This file NEVER touches capture.js, radar.html, structure-core.js, channel-core.js,
 * setups-core.js, regression-runner.js, capture.yml, data/daily, data/forward, or data/cache
 * (data/cache is read-only input). Its own writes are confined to data/replay/.
 *
 * CLI:
 *   node replay-driver.js --build-store            build data/replay/candles/*.json + universe.json
 *   node replay-driver.js --dev                    run the 48+2 policy family on the development split
 *   node replay-driver.js --contaminated [--policy N0]   replay the contaminated window (fixture cross-check)
 *   node replay-driver.js --select <runDir>         (implemented; NEVER invoked by the build — §7/v0.1)
 *   node replay-driver.js --validation <runDir>     refuses unless the named dev run's table+hash exist on disk
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const EC = require('../../episodes-core.js');
const OC = require('../../orders-core.js');
// orders-core.js's own documented test-only escape hatch (see its header comment): skip the defensive
// deep clone of the book on every step call. Safe here because every book this driver creates is owned
// by exactly one policy simulation and never aliased or read as "the previous immutable value" after a
// step call — the same discipline the module's own property tests rely on. Without this, book.attempts/
// book.orders growing over a year-long replay makes every step's JSON deep-clone O(n), and the whole
// walk O(days^2); with it, the walk is linear in days (verified: ~94s for 365+31 days x 50 policies).
OC.setInPlace(true);
const C = require('../../channel-core.js');

const ROOT = path.join(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, 'data', 'cache');
const REPLAY_DIR = path.join(ROOT, 'data', 'replay');
const CANDLES_DIR = path.join(REPLAY_DIR, 'candles');
const RUNS_DIR = path.join(REPLAY_DIR, 'runs');
const BASE_COMMIT = 'b10eef5ee803f857d01557ecb8dca110088c786f';
const DAY = 86400;

function num(v) { return typeof v === 'number' && isFinite(v); }
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
// Deterministic JSON: sorted keys at every level, no whitespace. Used for every hash and every run id.
function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  var keys = Object.keys(x).sort();
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(x[k]); }).join(',') + '}';
}
function sha256Of(obj) { return sha256Hex(Buffer.from(stableStringify(obj), 'utf8')); }

// ---- calendar (UTC, integer day arithmetic only — no Date.now(), no locale, no DST) ----
function ymdToSec(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error('bad date ' + ymd);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000);
}
function secToYmd(sec) {
  var d = new Date(sec * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function addDays(ymd, n) { return secToYmd(ymdToSec(ymd) + n * DAY); }
// inclusive date range as an array of 'YYYY-MM-DD' strings
function dateRange(startYmd, endYmd) {
  var out = [], s = ymdToSec(startYmd), e = ymdToSec(endYmd);
  for (var t = s; t <= e; t += DAY) out.push(secToYmd(t));
  return out;
}

// ---- deliverable 2: candle-store + universe builder (v0.1 ruling: built ONCE from data/cache/<cgId>.json
// at the pinned base commit; no live API fetch in the build. Universe = the current Kraken-designated-pair
// universe for the WHOLE window; Coinbase-only / CoinGecko-fallback coins excluded.) ----

// universe-core.js's own static exclusion lists, applied here exactly as the live universe applies them
// (a coin already had to clear these, plus the category/volume checks universe-core.js can't run
// historically, to ever be cached in the first place — this is a second, cheap, static-only pass).
var STABLES = ['usdt', 'usdc', 'busd', 'dai', 'tusd', 'fdusd', 'usdp', 'frax', 'lusd', 'usdd', 'eurs', 'usdn', 'usdg', 'usdf', 'bfusd', 'pyusd', 'usde', 'usds', 'ausd', 'eurc', 'paxg', 'xaut', 'wbtc', 'gho', 'jst', 'rai', 'lunc', 'ylds', 'sta', 'stable'];
var EXCLUDE_SYMBOLS = ['a7a5', 'prime', 'fig', 'figr_heloc', 'leo', 'ren', 'wbt', 'u', 'lin', 'ond', 'bdx', 'ava', 'mor', 'nea', 'cak', 'das', 'gra', 'm', 'nig', 'nex', 'has', 'gt', 'alg', 'pum'];
// Kraken's own legacy-ticker aliasing (mirrors exchange-map.js ALIAS) — capture.js labels a coin's cached
// candles by its CoinGecko SYMBOL (e.g. "doge/usd"), which is not always Kraken's real wsname (XDG/USD).
var KRAKEN_ALIAS = { BTC: ['XBT'], DOGE: ['XDG'], LUNA: ['LUNA2'] };

function normSym(s) { return String(s || '').replace(/[​‌‍﻿‎‏‪-‮]/g, '').trim().toLowerCase(); }
function slugPair(ws) { return ws.replace('/', '-'); }

function loadMetadataSnapshot() {
  var p = path.join(REPLAY_DIR, 'metadata-snapshot.json');
  if (!fs.existsSync(p)) throw new Error('data/replay/metadata-snapshot.json is missing. This driver never calls Kraken itself (build shells cannot reach it, v0.1 ruling) — the snapshot is a build INPUT, fetched once via the in-app browser and committed alongside the driver. See the handoff for how it was produced.');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Pure given (cacheDir, metadataSnapshot). No fs writes; buildStore() below does the I/O.
function computeStore(cacheFiles, metaSnap) {
  var metaByWs = metaSnap.pairs || {};
  var manifest = {}, skipped = {}, files = {};   // files: { 'PAIR-USD.json': {payload, sha256} }

  Object.keys(cacheFiles).sort().forEach(function (cgId) {
    var d = cacheFiles[cgId];
    var symbol = normSym(d.symbol);
    var ohlcDaily = d.ohlcDaily || [];
    if (!ohlcDaily.length) { skipped[cgId] = 'no-ohlcDaily'; return; }
    var pairCounts = {};
    ohlcDaily.forEach(function (c) { if (c.venue === 'kraken' && c.pair) pairCounts[c.pair] = (pairCounts[c.pair] || 0) + 1; });
    var pairs = Object.keys(pairCounts);
    if (!pairs.length) { skipped[cgId] = 'no-kraken-candles'; return; }
    var designatedPair = pairs.sort(function (a, b) { return pairCounts[b] - pairCounts[a]; })[0];
    var ws = designatedPair.toUpperCase(), baseSym = ws.split('/')[0];
    var meta = metaByWs[ws], usedWs = ws;
    if (!meta) {
      (KRAKEN_ALIAS[baseSym] || []).some(function (a) { var altWs = a + '/USD'; if (metaByWs[altWs]) { meta = metaByWs[altWs]; usedWs = altWs; return true; } return false; });
    }
    if (!meta) { skipped[cgId] = 'pair-not-in-metadata-snapshot:' + designatedPair; return; }
    ws = usedWs;

    var byTime = {};
    ohlcDaily.forEach(function (c) {
      if (c.venue !== 'kraken' || c.pair !== designatedPair) return;
      if (c.isClosed === false) return;
      if (!num(c.time)) return;
      byTime[c.time] = c;
    });
    var times = Object.keys(byTime).map(Number).sort(function (a, b) { return a - b; });
    if (!times.length) { skipped[cgId] = 'empty-after-filter'; return; }
    var lean = times.map(function (t) {
      var c = byTime[t], vol = c.volume, raw = c.raw, vwap = (Array.isArray(raw) && raw.length > 5) ? +raw[5] : null;
      var px = (num(vwap) && vwap > 0) ? vwap : c.close, qv = (num(vol) && num(px)) ? vol * px : null;
      return { id: t, time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: num(vol) ? vol : null, quoteVolumeUsd: num(qv) ? qv : null, date: c.date };
    });

    var isBtc = (symbol === 'btc' || symbol === 'wbtc');
    var excludedReason = null;
    if (STABLES.indexOf(symbol) >= 0) excludedReason = 'stablecoin-symbol';
    else if (EXCLUDE_SYMBOLS.indexOf(symbol) >= 0) excludedReason = 'excluded-symbol';
    else if (isBtc) excludedReason = 'btc-benchmark';

    var fname = slugPair(ws) + '.json';
    var payload = { schemaVersion: 1, pair: ws, krakenAltname: meta.altname || null, cgId: cgId, symbol: d.symbol,
      venue: 'kraken', source: 'data/cache/' + cgId + '.json @ ' + BASE_COMMIT, candles: lean };
    var fhash = sha256Of(payload);
    files[fname] = { payload: payload, sha256: fhash };
    manifest[cgId] = { cgId: cgId, symbol: d.symbol, pair: ws, krakenAltname: meta.altname || null, file: 'candles/' + fname, sha256: fhash,
      meta: { tick: meta.tick, lot: meta.lot, minOrder: meta.minOrder }, candleCount: lean.length,
      firstDate: lean[0].date, lastDate: lean[lean.length - 1].date, firstTime: lean[0].time, lastTime: lean[lean.length - 1].time,
      tradeable: excludedReason === null, excludedReason: excludedReason };
  });

  var lines = Object.keys(manifest).sort().map(function (cg) { return cg + ':' + manifest[cg].sha256; });
  var storeHash = sha256Hex(Buffer.from(lines.join('\n'), 'utf8'));
  var metaHash = sha256Of(metaSnap);
  var universeDoc = { schemaVersion: 1, baseCommit: BASE_COMMIT, builtFrom: 'data/cache/<cgId>.json at the pinned base commit (no live API fetch; v0.1 ruling)',
    metadataSnapshotSha256: metaHash, storeHash: storeHash, coinCount: Object.keys(manifest).length,
    tradeableCount: Object.keys(manifest).filter(function (cg) { return manifest[cg].tradeable; }).length,
    coins: Object.keys(manifest).sort().map(function (cg) { return manifest[cg]; }), skipped: skipped };
  return { files: files, universeDoc: universeDoc };
}

// Git blob sha1 (same object model git itself uses: sha1("blob " + len + "\0" + content)) — computed
// entirely offline, no network. Lets verifyPinnedCache() compare a working file to the exact byte
// content GitHub had at BASE_COMMIT without ever calling the GitHub API from inside the store builder.
function gitBlobSha1(buf) {
  var header = Buffer.from('blob ' + buf.length + '\0', 'latin1');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

// Guard (2026-09-27, analysis-thread finding): buildStore() previously trusted whatever data/cache/*.json
// happened to be on disk. A device-mirror fetch that silently dropped one file (zcash.json, cgId
// "zcash") produced a 96-coin/95-tradeable store with no error — wrong, but not obviously wrong, since
// nothing checked the fetched set against the pinned commit it claimed to be built from. This reads the
// static manifest (pinned-cache-manifest.json — the GitHub contents-API listing of data/cache at
// BASE_COMMIT, git blob sha1 per file, captured once, no live call here) and hard-aborts on ANY mismatch:
// a missing file, an extra file, or a content drift on a file that IS present. No auto-repair, no partial
// build — the point is to fail loudly instead of silently building from the wrong 110-of-111 files again.
function verifyPinnedCache() {
  var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'pinned-cache-manifest.json'), 'utf8'));
  if (manifest.baseCommit !== BASE_COMMIT) throw new Error('pinned-cache-manifest.json baseCommit (' + manifest.baseCommit + ') does not match BASE_COMMIT (' + BASE_COMMIT + ') — driver and manifest have drifted apart');
  var expected = {}; manifest.files.forEach(function (f) { expected[f.name] = f; });
  var onDisk = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter(function (n) { return /\.json$/.test(n); }) : [];
  var onDiskSet = {}; onDisk.forEach(function (n) { onDiskSet[n] = true; });
  var missing = Object.keys(expected).filter(function (n) { return !onDiskSet[n]; });
  var extra = onDisk.filter(function (n) { return !expected[n]; });
  var drifted = [];
  onDisk.forEach(function (n) {
    if (!expected[n]) return;
    var buf = fs.readFileSync(path.join(CACHE_DIR, n));
    var actual = gitBlobSha1(buf);
    if (actual !== expected[n].sha1) drifted.push({ name: n, expected: expected[n].sha1, actual: actual, expectedSize: expected[n].size, actualSize: buf.length });
  });
  if (missing.length || extra.length || drifted.length) {
    var msg = 'data/cache does not match BASE_COMMIT (' + BASE_COMMIT + ') — refusing to build the candle store from a drifted or incomplete cache.';
    if (missing.length) msg += '\n  missing (' + missing.length + '): ' + missing.join(', ');
    if (extra.length) msg += '\n  unexpected/extra (' + extra.length + '): ' + extra.join(', ');
    if (drifted.length) msg += '\n  content mismatch (' + drifted.length + '): ' + drifted.map(function (d) { return d.name + ' (expected ' + d.expected + ' size ' + d.expectedSize + ', got ' + d.actual + ' size ' + d.actualSize + ')'; }).join('; ');
    throw new Error(msg);
  }
  return { checked: onDisk.length, expectedCount: manifest.fileCount };
}

function buildStore() {
  if (!fs.existsSync(CACHE_DIR)) throw new Error('data/cache not found at ' + CACHE_DIR);
  var guard = verifyPinnedCache();
  console.log('verifyPinnedCache: OK,', guard.checked, '/', guard.expectedCount, 'files match BASE_COMMIT byte-for-byte');
  var metaSnap = loadMetadataSnapshot();
  var names = fs.readdirSync(CACHE_DIR).filter(function (n) { return /\.json$/.test(n); }).sort();
  var cacheFiles = {};
  names.forEach(function (n) { cacheFiles[n.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, n), 'utf8')); });
  var res = computeStore(cacheFiles, metaSnap);
  fs.mkdirSync(CANDLES_DIR, { recursive: true });
  Object.keys(res.files).forEach(function (fname) { fs.writeFileSync(path.join(CANDLES_DIR, fname), JSON.stringify(res.files[fname].payload, null, 1)); });
  fs.writeFileSync(path.join(REPLAY_DIR, 'universe.json'), JSON.stringify(res.universeDoc, null, 1));
  console.log('buildStore: coins', res.universeDoc.coinCount, 'tradeable', res.universeDoc.tradeableCount, 'skipped', Object.keys(res.universeDoc.skipped).length);
  console.log('storeHash', res.universeDoc.storeHash);
  return res.universeDoc;
}

// ---- load the built store once per process; pure in-memory data, never mutated ----
function loadUniverse() {
  var doc = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'universe.json'), 'utf8'));
  var byCgId = {};
  doc.coins.forEach(function (c) {
    var store = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, c.file), 'utf8'));
    var actualHash = sha256Of(store);
    if (actualHash !== c.sha256) throw new Error('candle store drift: ' + c.file + ' expected ' + c.sha256 + ' got ' + actualHash);
    byCgId[c.cgId] = { cgId: c.cgId, symbol: c.symbol, pair: c.pair, meta: c.meta, tradeable: c.tradeable, excludedReason: c.excludedReason,
      firstDate: c.firstDate, candles: store.candles };
  });
  var btc = byCgId['bitcoin'];
  if (!btc) throw new Error('bitcoin (BTC regime reference) missing from the built universe');
  return { doc: doc, byCgId: byCgId, btcCandles: btc.candles, storeHash: doc.storeHash, metadataSnapshotSha256: doc.metadataSnapshotSha256 };
}

// usable at cutoffSec: candle.time + DAY <= cutoffSec (bar-close context — no lookahead; the replay has no
// fetchedAt lag to model, unlike the live cohort, so "usable" collapses to this one calendar test).
function usableSlice(candles, cutoffSec) {
  var out = [];
  for (var i = 0; i < candles.length; i++) { if (candles[i].time + DAY <= cutoffSec) out.push(candles[i]); else break; }
  return out;
}

function captureFor(dateStr) {
  var cutoffSec = ymdToSec(dateStr);
  return { captureId: 'D-' + dateStr, date: dateStr, inputCutoffSec: cutoffSec, inputCutoffUtc: dateStr + 'T00:00:00Z', issueTimeUtc: cutoffSec + 600 };
}

// research row shape episodes-core.js expects: { fit:{fitId,pivotIds,supSlope,supIntercept,supportNow,invalidation,
// atr14,channelH,supportTouches,lifecycleState}, price, gates[], entryEconomics{...} } — mirrors capture.js's own
// fwdResearchRow() exactly (see capture.js line ~1311), applied to a HISTORICAL bar-close fit/ctx instead of a live one.
function researchRowOf(fit, res, price) {
  if (!fit) return null;
  return {
    fit: { fitId: fit.fitId, pivotIds: fit.pivotIds || [], supSlope: fit.supSlope, supIntercept: fit.supIntercept, supportNow: fit.supportNow,
      invalidation: fit.invalidation, atr14: fit.atr14, resistNow: fit.resistNow, channelH: fit.channelH, supportTouches: fit.supportTouches, lifecycleState: fit.lifecycleState },
    price: price, gates: (res && res.details && res.details.gates) || null, score: num(fit.score) ? fit.score : null,
    entryEconomics: fit.entryEconomics ? { entryZone: fit.entryEconomics.entryZone, entryRef: fit.entryEconomics.entryRef, defendedLow: fit.entryEconomics.defendedLow,
      stop: fit.entryEconomics.stop, stopBasis: fit.entryEconomics.stopBasis, target: fit.entryEconomics.target, targetSource: fit.entryEconomics.targetSource,
      netRR: fit.entryEconomics.netRR, grossRR: fit.entryEconomics.grossRR, atr14: fit.entryEconomics.atr14 } : null
  };
}

// The 16 research gate ids, channel-core.js order (mirrors capture.js's FWD_KNOWN_GATE_IDS verbatim — a test
// asserts equality against channel-core.researchVerdict's own emitted gate ids on a fixture fit).
var GATE_IDS = ['data.fit', 'data.price', 'struct.lifecycle', 'struct.quote-breach', 'struct.below-rail', 'C1.trend', 'C3.fresh-touch',
  'C3.no-recent-break', 'C7.floor', 'C2.width', 'C2.entry-zone', 'C6.spike', 'H6.rr', 'C4.volume24h', 'C4.touch-volume', 'C5.btc-regime'];

var MIN_CANDLES_FOR_FIT = 30;   // capture.js's own research-pass gate (cands.length >= 30) before it will call detectChannel at all

// Step 1 (append usable candles) + step 6 (episode lifecycle/matching), computed ONCE per capture and shared
// across every policy's book: episodes-core.js's updateEpisodes() takes no book/order input except
// orderObligations, which feeds only the cosmetic obligationCandles field (never matching/opening/lifecycle) —
// see episodes-core.js's own code. The replay always passes [] for orderObligations (no fetch-list to
// optimize, unlike the live cohort), so the episode state is provably policy-independent and is computed once.
function sharedDayStep(universe, dateStr, priorEpisodesState, cfg) {
  var capture = captureFor(dateStr), cutoffSec = capture.inputCutoffSec;
  var btcUsable = usableSlice(universe.btcCandles, cutoffSec);
  var btcRegime = btcUsable.length ? C.btcRegimeFromCandles(btcUsable) : null;

  var bars = {}, universeIds = [], researchRows = {};
  Object.keys(universe.byCgId).forEach(function (cgId) {
    var coin = universe.byCgId[cgId];
    var usable = usableSlice(coin.candles, cutoffSec);
    bars[cgId] = { pair: coin.pair, venueEligible: true, metadataEligible: true, candles: usable.map(function (c) { return { id: c.id, open: c.open, high: c.high, low: c.low, close: c.close }; }) };
    if (!coin.tradeable) return;   // BTC benchmark / stablecoin-symbol / excluded-symbol: candles kept for regime/context only, never episoded or traded
    if (!usable.length || usable[0].date > dateStr) return;   // not yet listed as of D-1
    universeIds.push(cgId);
    if (usable.length < MIN_CANDLES_FOR_FIT) return;   // capture.js's own gate: no detectChannel call below 30 usable candles
    var fit = C.detectChannel(usable, null, { coinId: cgId, timeframe: '1d', source: 'kraken', research: true });
    if (!fit) return;
    var last = usable[usable.length - 1];
    var res = C.researchVerdict(fit, { price: last.close, volume24h: num(last.quoteVolumeUsd) ? last.quoteVolumeUsd : null, btc: btcRegime, quote: null, floor: C.ACT_SCORE_FLOOR_1D });
    researchRows[cgId] = researchRowOf(fit, res, last.close);
  });

  var eu = EC.updateEpisodes(priorEpisodesState, capture, researchRows, bars, universeIds, [], cfg || EC.DEFAULT_CFG);
  var candidates = eu.episodeDays.map(function (ed) {
    var coin = universe.byCgId[ed.cgId];
    // _channelH: episodeDays (episodes-core.js) carries fitId/entryEconomics/score/gates but never the fit's own
    // channelH — joined back here from this capture's researchRows (same cgId, same fit) so applyTargetOverride's
    // channel-height measured-move variant has a real geometry input instead of silently no-op'ing.
    var rr = researchRows[ed.cgId];
    return { episodeId: ed.episodeId, cgId: ed.cgId, pair: ed.pair, screen: ed.screen, price: ed.price, score: ed.score,
      entryEconomics: ed.entryEconomics, venueEligible: ed.venueEligible !== false, gates: ed.gates || null, meta: coin ? coin.meta : null,
      _channelH: (rr && rr.fit && num(rr.fit.channelH)) ? rr.fit.channelH : null };
  });
  return { capture: capture, bars: bars, candidates: candidates, nextEpisodesState: eu.state, btcRegime: btcRegime, episodeDays: eu.episodeDays };
}

// Steps 2, 3, 4, 5, 7 for ONE policy's book on this capture (step 6 already ran in sharedDayStep; that is a
// deliberate, verified-safe reordering — see the acceptance-2 test, which asserts EC/OC call order per capture).
function policyDayStep(book, pid, policy, capture, bars, candidates, cfg, issuanceAllowed) {
  book = OC.adjudicateAll(book, capture, bars);
  book = OC.activateAll(book, capture, bars);
  book = OC.valuation(book, pid, capture, bars);
  book = OC.suspend(book, pid, capture);
  if (issuanceAllowed) { var r = OC.issueBatch(book, policy, candidates, capture, cfg); book = r.book; }
  return book;
}

// ---- deliverable 4: policy family (predeclared; §3/§8 of the spec) ----
function subsetsOf(arr) {   // all 2^n subsets, smallest first, deterministic order
  var out = [[]];
  arr.forEach(function (x) { out = out.concat(out.map(function (s) { return s.concat([x]); })); });
  out.sort(function (a, b) { return a.length - b.length || a.join(',').localeCompare(b.join(',')); });
  return out;
}
function buildPolicyFamily() {
  var grid = [];
  [70, 75, 80].forEach(function (minScore) {
    subsetsOf(['C1.trend', 'C3.fresh-touch']).forEach(function (requiredGates) {
      [1.5, 2.0].forEach(function (minNetRR) {
        [[], ['cap']].forEach(function (excludeStopBasis) {
          var label = 'G-score' + minScore + '-gates[' + requiredGates.join('+') + ']-rr' + minNetRR + '-' + (excludeStopBasis.length ? 'exCap' : 'inclCap');
          grid.push({ id: 'C1', label: label, version: 'replay-' + label, family: 'grid',
            cfg: { minScore: minScore, minNetRR: minNetRR, requiredGates: requiredGates, excludeStopBasis: excludeStopBasis } });
        });
      });
    });
  });
  var n0 = { id: 'N0', label: 'N0', version: 'baseline-screen-inzone', family: 'reference', cfg: null };
  var b0hist = { id: 'C1', label: 'B0-hist', version: 'replay-B0hist', family: 'reference', cfg: { requiredGates: GATE_IDS.slice() } };
  // Exploratory variants reuse the N0 (screen+in-zone) predicate — orders-core.js's predicateHolds special-cases
  // policy.id==='N0' to skip qualify() entirely (see orders-core.js:289); a non-null cfg here would instead route
  // through qualify(cfg.challenger, cand), which requires challengerActive() (some minScore/minNetRR/requiredGates/
  // excludeStopBasis) to be true or every candidate is rejected — cfg:{} is NOT active and issues zero orders.
  // Each variant gets its own book (keyed by label in simulateFamily), so reusing id:'N0' here never collides with
  // the real N0 reference policy's own book/account.
  var measuredMove = [
    { id: 'N0', label: 'MM-channel-height', version: 'replay-mm-channel', family: 'exploratory', targetOverride: 'channel-height', cfg: null },
    { id: 'N0', label: 'MM-2R', version: 'replay-mm-2r', family: 'exploratory', targetOverride: '2r', cfg: null }
  ];
  return { grid: grid, n0: n0, b0hist: b0hist, measuredMove: measuredMove, eligibleFamily: [n0, b0hist].concat(grid) };
}

// Exploratory measured-move variants change the reward definition itself (target/stop are no longer the
// detector's logged levels), so they are applied to a CLONE of each candidate's entryEconomics before
// issueBatch sees it — never by touching orders-core.js's own level-from-log-row logic.
function applyTargetOverride(candidates, kind) {
  return candidates.map(function (c) {
    if (!c.entryEconomics || !c.screen || !c.screen.pass) return c;
    var ee = c.entryEconomics, entryRef = ee.entryRef, stop = ee.stop;
    if (!num(entryRef) || !num(stop)) return c;
    var channelH = null;   // channel height is on the fit, not entryEconomics; candidates carry gates/score only from episodeDays.
    var target = kind === '2r' ? entryRef + 2 * (entryRef - stop) : null;
    if (kind === 'channel-height' && num(c._channelH)) target = entryRef + c._channelH;
    if (!num(target) || target <= entryRef) return c;
    var risk = entryRef - stop, cost = 0.003 * entryRef, netRR = (risk > 0) ? (target - entryRef - cost) / (risk + cost) : null;
    return Object.assign({}, c, { entryEconomics: Object.assign({}, ee, { target: target, targetSource: kind, netRR: netRR }) });
  });
}

// ---- deliverable 1/5: simulate the whole policy family over a contiguous capture range, shared episode
// state computed once per day, one lightweight order book per policy (§4.0 order preserved per book: see
// the acceptance-2 pipeline-order test). issuanceAllowed(dateStr) gates step 7 only (steps 1-6 always run,
// so orders issued near a split's end still adjudicate/exit during a following embargo/continuation range). ----
function simulateFamily(universe, dateList, policies, issuanceAllowedFn, cfgBase, onDay) {
  var books = {}, priorEpisodes = null, cfgB = cfgBase || EC.DEFAULT_CFG;
  policies.forEach(function (p) { books[p.label] = OC.newBook(); });
  dateList.forEach(function (dateStr) {
    var shared = sharedDayStep(universe, dateStr, priorEpisodes, cfgB);
    priorEpisodes = shared.nextEpisodesState;
    var allowIssue = issuanceAllowedFn(dateStr);
    policies.forEach(function (p) {
      var cands = p.targetOverride ? applyTargetOverride(shared.candidates, p.targetOverride) : shared.candidates;
      var cfg = p.cfg ? { challenger: p.cfg } : {};
      books[p.label] = policyDayStep(books[p.label], p.id, { id: p.id, version: p.version }, shared.capture, shared.bars, cands, cfg, allowIssue);
    });
    if (onDay) onDay(dateStr, shared);
  });
  return books;
}

// ---- deliverable 6 (part): Protocol §7 statistics, reused verbatim (same PRNG, same bootstrap, same bound
// formula; applied here to the development/contaminated window's own daily series instead of the N=395
// cohort window). ----
function splitmix32Next(state) {   // state: {a: uint32}; mutates and returns the uint32 output
  state.a = (state.a + 0x9E3779B9) | 0;
  var t = state.a ^ (state.a >>> 15);
  t = Math.imul(t, 0x85EBCA6B);
  t ^= t >>> 13;
  t = Math.imul(t, 0xC2B2AE35);
  return (t ^ (t >>> 16)) >>> 0;
}
function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
function makeXoshiro128ss(seedA) {
  var sm = { a: seedA >>> 0 }, s = [splitmix32Next(sm), splitmix32Next(sm), splitmix32Next(sm), splitmix32Next(sm)];
  function next() {
    var result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    var t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0; s[3] = (s[3] ^ s[1]) >>> 0; s[1] = (s[1] ^ s[2]) >>> 0; s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0; s[3] = rotl(s[3], 11);
    return result;
  }
  return { next: next };
}
function goldenVector(seedA, count) {
  var g = makeXoshiro128ss(seedA), out = [];
  for (var i = 0; i < count; i++) out.push(g.next());
  return out;
}
function drawIndex(gen, N) { return Math.floor((gen.next() >>> 0) / 4294967296 * N); }

// Circular moving-block bootstrap resample of index [0..N-1]: draw start indices until >= N records, wrap
// modulo N, truncate to N. Returns an array of N indices into the original series (repeats allowed).
function blockResampleIndices(gen, N, b) {
  var idx = [];
  while (idx.length < N) { var start = drawIndex(gen, N); for (var k = 0; k < b; k++) idx.push((start + k) % N); }
  return idx.slice(0, N);
}
function percentileBound(values, pct) {   // pct in (0,1); 0-based ascending sort, linear interpolation
  var x = values.slice().sort(function (a, b) { return a - b; }), n = x.length;
  if (n === 0) return null;
  var k = (n - 1) * pct, lo = Math.floor(k), hi = Math.min(lo + 1, n - 1);
  return x[lo] + (k - lo) * (x[hi] - x[lo]);
}
// dailySums/dailyCounts: parallel arrays over the analysis window's calendar days (index 0..N-1, in date
// order). Returns { pointEstimate, lowerBound90, replications } — ratio-of-sums expectancy per Protocol §7;
// a replication with zero sampled trades is undefined and excluded (unvalidated if ALL are undefined).
function bootstrapMeanBudgetR(dailySums, dailyCounts, seedA, b, reps) {
  var N = dailySums.length, totalSum = 0, totalCount = 0;
  for (var i = 0; i < N; i++) { totalSum += dailySums[i]; totalCount += dailyCounts[i]; }
  var pointEstimate = totalCount > 0 ? totalSum / totalCount : null;
  if (N === 0) return { pointEstimate: pointEstimate, lowerBound90: null, replications: 0, undefinedReplications: 0, unvalidated: true };
  var gen = makeXoshiro128ss(seedA), values = [], undef = 0;
  for (var r = 0; r < reps; r++) {
    var idx = blockResampleIndices(gen, N, b), s = 0, c = 0;
    for (var j = 0; j < idx.length; j++) { s += dailySums[idx[j]]; c += dailyCounts[idx[j]]; }
    if (c === 0) { undef++; continue; }
    values.push(s / c);
  }
  var unvalidated = values.length === 0;
  return { pointEstimate: pointEstimate, lowerBound90: unvalidated ? null : percentileBound(values, 0.10), replications: values.length, undefinedReplications: undef, unvalidated: unvalidated };
}

// ---- PBO via CSCV (Bailey, Borwein, Lopez de Prado & Zhu): split the development window into `blocks`
// contiguous, equal-length calendar blocks; for every equal-size train/test split (C(blocks, blocks/2)
// combinations), rank policies in-sample (IS) by mean budget-R, take the IS winner, find its out-of-sample
// (OOS) percentile rank; PBO = fraction of combinations where the IS winner's OOS rank is in the WORSE half. ----
function combinations(n, k) {   // all k-subsets of [0..n-1], as arrays, deterministic (lexicographic) order
  var out = [], combo = [];
  function rec(start) {
    if (combo.length === k) { out.push(combo.slice()); return; }
    for (var i = start; i < n; i++) { combo.push(i); rec(i + 1); combo.pop(); }
  }
  rec(0);
  return out;
}
// perPolicyDaily: { label: {sums:[...], counts:[...]} } all over the SAME N-day window. blocks divides N
// into `blocks` contiguous groups (last group absorbs any remainder).
function pboCscv(perPolicyDaily, N, blocks) {
  var labels = Object.keys(perPolicyDaily);
  var groupSize = Math.floor(N / blocks), groups = [];
  for (var g = 0; g < blocks; g++) { var s = g * groupSize, e = (g === blocks - 1) ? N : s + groupSize; groups.push({ start: s, end: e }); }
  function meanR(label, groupIdxs) {
    var sum = 0, count = 0, d = perPolicyDaily[label];
    groupIdxs.forEach(function (gi) { for (var i = groups[gi].start; i < groups[gi].end; i++) { sum += d.sums[i]; count += d.counts[i]; } });
    return count > 0 ? sum / count : -Infinity;
  }
  var half = blocks / 2;
  if (!Number.isInteger(half)) throw new Error('pboCscv requires an even block count');
  var trainSets = combinations(blocks, half), worseHalfCount = 0, total = 0;
  trainSets.forEach(function (train) {
    var trainSet = {}; train.forEach(function (i) { trainSet[i] = 1; });
    var testIdxs = [], trainIdxs = train;
    for (var g = 0; g < blocks; g++) if (!trainSet[g]) testIdxs.push(g);
    var isScores = labels.map(function (l) { return { l: l, v: meanR(l, trainIdxs) }; });
    var best = isScores.reduce(function (a, b) { return b.v > a.v ? b : a; });
    var oosScores = labels.map(function (l) { return { l: l, v: meanR(l, testIdxs) }; }).sort(function (a, b) { return a.v - b.v; });
    var rank = oosScores.findIndex(function (x) { return x.l === best.l; });   // 0 = worst OOS
    var percentile = (rank + 0.5) / oosScores.length;
    if (percentile <= 0.5) worseHalfCount++;
    total++;
  });
  return { pbo: total > 0 ? worseHalfCount / total : null, combinations: total, blocks: blocks };
}

// ---- per-policy statistics (deliverable 5 report content) ----
// windowDates: the ELIGIBILITY window's own calendar days ('YYYY-MM-DD', in order) — development or
// contaminated. Exits landing after the window (resolved during an embargo/continuation extension) are
// attributed to the window's own last date, mirroring Protocol §7's min(N-1,d) clamp exactly.
function statsForPolicy(book, pid, windowDates) {
  var windowStart = windowDates[0], windowEnd = windowDates[windowDates.length - 1];
  var dateIdx = {}; windowDates.forEach(function (d, i) { dateIdx[d] = i; });
  var attempts = book.attempts.filter(function (a) { return a.policyId === pid && a.date >= windowStart && a.date <= windowEnd; });
  var funnel = {}; attempts.forEach(function (a) { funnel[a.outcome] = (funnel[a.outcome] || 0) + 1; });
  var orders = book.orders.filter(function (o) { return o.policyId === pid && o.issueDate >= windowStart && o.issueDate <= windowEnd; });
  var filled = orders.filter(function (o) { return o.fill; });
  var exited = filled.filter(function (o) { return o.exit; });
  var exitReasons = {}; exited.forEach(function (o) { exitReasons[o.exit.reason] = (exitReasons[o.exit.reason] || 0) + 1; });
  var budgetRs = exited.map(function (o) { return o.exit.budgetR; }).filter(num);
  var sortedR = budgetRs.slice().sort(function (a, b) { return a - b; });
  var meanR = budgetRs.length ? budgetRs.reduce(function (s, v) { return s + v; }, 0) / budgetRs.length : null;
  var medianR = sortedR.length ? (sortedR.length % 2 ? sortedR[(sortedR.length - 1) / 2] : (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2) : null;
  var fillsByMonth = {}; filled.forEach(function (o) { var m = (o.fill.date || o.issueDate).slice(0, 7); fillsByMonth[m] = (fillsByMonth[m] || 0) + 1; });
  var seriesInWindow = book.accounts[pid].series.filter(function (r) { return r.date >= windowStart && r.date <= windowEnd; });
  var maxDrawdown = seriesInWindow.reduce(function (m, r) { return Math.max(m, r.drawdown || 0); }, 0);
  var suspended = seriesInWindow.some(function (r) { return r.suspended; });
  var monthlyR = {}; exited.forEach(function (o) { var m = (o.exit.date || o.fill.date).slice(0, 7); monthlyR[m] = (monthlyR[m] || 0) + o.exit.budgetR; });
  var crossTab = {}; orders.forEach(function (o) { var k = (o.stopBasis || 'null') + '|' + (o.targetSource || 'null'); crossTab[k] = (crossTab[k] || 0) + 1; });
  var sizeClippedCount = filled.filter(function (o) { return o.sizeClipped; }).length;

  var dailySums = windowDates.map(function () { return 0; }), dailyCounts = windowDates.map(function () { return 0; });
  exited.forEach(function (o) {
    var d = o.exit.date || o.fill.date, i = dateIdx[d];
    if (i === undefined) i = dateIdx[windowEnd];   // clamp: exit resolved outside the window (e.g. during embargo) attributes to the last day, per Protocol §7's min(N-1,d)
    dailySums[i] += o.exit.budgetR; dailyCounts[i] += 1;
  });

  return {
    policyId: pid, episodeDaysConsumedAttempts: attempts.length, funnel: funnel,
    issued: orders.length, filled: filled.length, exited: exited.length, exitReasons: exitReasons,
    meanBudgetR: meanR, medianBudgetR: medianR, fillsByMonth: fillsByMonth, fillsTotal: filled.length,
    maxDrawdown: maxDrawdown, suspended: suspended, monthlyBudgetR: monthlyR, stopBasisTargetSourceCrossTab: crossTab,
    sizeClippedCount: sizeClippedCount, dailySums: dailySums, dailyCounts: dailyCounts
  };
}

function bootstrapReportFor(stats, seedA, primaryB) {
  var primary = bootstrapMeanBudgetR(stats.dailySums, stats.dailyCounts, seedA, primaryB, 10000);
  var sens = {};
  [10, 40].forEach(function (b) { sens['b' + b] = bootstrapMeanBudgetR(stats.dailySums, stats.dailyCounts, seedA, b, 10000); });
  return { primary: primary, sensitivity: sens };
}

// The context differences from the live cohort, printed verbatim in every report header (spec §1, §8).
var CONTEXT_DIFFERENCES = [
  "price = the D-1 daily candle's close (live: the capture-time last-trade quote)",
  "volume24h = the D-1 daily candle's quote volume in USD, base-volume x vwap (live: the capture-time exchange/CoinGecko 24h volume)",
  "BTC regime (C5.btc-regime) = btcRegimeFromCandles() on the cached BTC candle series usable as of D (live: the same function on that capture's own freshly-fetched BTC series — identical definition, historical input)",
  "touch volume (C4.touch-volume) = channel-core's own volTouch on the same lean candle array (identical to live; no substitution)",
  "universe = the CURRENT Kraken-designated-pair universe held for the WHOLE window, not a monthly-reconstructed historical universe (v0.1 ruling; survivorship bias is therefore larger than a reconstructed universe would show)",
  "designated pair and Kraken tick/lot/minOrder metadata are fixed for the whole window from one current snapshot, not re-derived per historical capture",
  "no fetchedAt/latency modeling: a candle is usable as soon as its calendar day has closed (no live network lag to simulate)"
];

var ENGINE_VERSION = 'replay-driver-v0.1';
var SEED = 20260925, PRIMARY_B = 20, DEV_START = '2024-09-01', DEV_END = '2025-07-31', EMBARGO_END = '2025-08-31';
var CONTAM_START = '2026-06-16', CONTAM_END = '2026-09-16';

function fillsPerMonthAvg(stats, windowDates) {
  var months = {}; windowDates.forEach(function (d) { months[d.slice(0, 7)] = 1; });
  var n = Object.keys(months).length || 1;
  return stats.fillsTotal / n;
}

function runHeader(universe, extra) {
  return Object.assign({
    engineVersion: ENGINE_VERSION, baseCommit: BASE_COMMIT, storeHash: universe.storeHash, metadataSnapshotSha256: universe.metadataSnapshotSha256,
    survivorshipNote: 'Universe = the CURRENT (build-time) Kraken-designated-pair universe, held fixed for the whole window (v0.1 ruling). Coins that were once tradeable and are now delisted/dead cannot be reconstructed from the live caches this build reads, so survivorship bias here is LARGER than a monthly-reconstructed historical universe would show (spec §1/§8).',
    contextDifferencesFromLive: CONTEXT_DIFFERENCES, seed: SEED
  }, extra || {});
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 1)); }

// ---- deliverable 1/3/4/5: the development run (the ONLY split this build executes; see the CLI guard) ----
function runDevelopment() {
  var universe = loadUniverse();
  var fam = buildPolicyFamily();
  var simDates = dateRange(DEV_START, EMBARGO_END);
  var windowDates = dateRange(DEV_START, DEV_END);
  var policyKey = fam.eligibleFamily.map(function (p) { return { label: p.label, id: p.id, version: p.version, cfg: p.cfg }; });
  var rid = sha256Of({ kind: 'development', storeHash: universe.storeHash, metadataSnapshotSha256: universe.metadataSnapshotSha256,
    policies: policyKey, devStart: DEV_START, devEnd: DEV_END, embargoEnd: EMBARGO_END, seed: SEED, engineVersion: ENGINE_VERSION }).slice(0, 16);

  var books = simulateFamily(universe, simDates, fam.eligibleFamily, function (d) { return d <= DEV_END; }, null, null);

  var rows = fam.eligibleFamily.map(function (p) {
    var st = statsForPolicy(books[p.label], p.id, windowDates);
    var bs = bootstrapReportFor(st, SEED, PRIMARY_B);
    var eligible = st.filled >= 30 && !st.suspended;
    return { label: p.label, family: p.family, policyId: p.id, version: p.version, cfg: p.cfg, eligible: eligible,
      filled: st.filled, issued: st.issued, exited: st.exited, exitReasons: st.exitReasons, funnel: st.funnel,
      meanBudgetR: st.meanBudgetR, medianBudgetR: st.medianBudgetR, fillsPerMonth: fillsPerMonthAvg(st, windowDates),
      maxDrawdown: st.maxDrawdown, suspended: st.suspended, monthlyBudgetR: st.monthlyBudgetR, stopBasisTargetSourceCrossTab: st.stopBasisTargetSourceCrossTab,
      sizeClippedCount: st.sizeClippedCount, bootstrap: bs };
  });

  var gridRows = rows.filter(function (r) { return r.family === 'grid'; });
  var eligibleGrid = gridRows.filter(function (r) { return r.eligible; });
  var ranked = eligibleGrid.slice().sort(function (a, b) {
    var la = a.bootstrap.primary.lowerBound90, lb = b.bootstrap.primary.lowerBound90;
    if (la == null && lb == null) return 0; if (la == null) return 1; if (lb == null) return -1;
    if (lb !== la) return lb - la;
    if (b.fillsPerMonth !== a.fillsPerMonth) return b.fillsPerMonth - a.fillsPerMonth;
    return a.maxDrawdown - b.maxDrawdown;
  });
  var winner = ranked.length ? ranked[0] : null;

  var perPolicyDaily = {}; gridRows.forEach(function (r) {
    var st = statsForPolicy(books[r.label], r.policyId, windowDates);
    perPolicyDaily[r.label] = { sums: st.dailySums, counts: st.dailyCounts };
  });
  var pbo = pboCscv(perPolicyDaily, windowDates.length, 16);

  var recommendation = (!winner || winner.bootstrap.primary.lowerBound90 == null) ? 'no-eligible-configuration'
    : 'candidate-selected (validation NOT run this build — v0.1 ruling: selection is not applied until the analysis-thread review of the family and rule is in)';

  var doc = runHeader(universe, {
    kind: 'development-table', split: { start: DEV_START, end: DEV_END, embargoEnd: EMBARGO_END, simulatedThrough: EMBARGO_END },
    runId: rid, policyFamilySize: fam.eligibleFamily.length, gridSize: fam.grid.length,
    eligibilityRule: '>= 30 filled orders in development; no suspension in development',
    selectionRule: 'one-sided 90% lower bootstrap bound on mean budget-R (b=20, seed ' + SEED + '), ties by fills/month then by smaller max drawdown',
    rows: rows, developmentRanking: ranked.map(function (r) { return { label: r.label, lowerBound90: r.bootstrap.primary.lowerBound90, meanBudgetR: r.meanBudgetR, filled: r.filled, fillsPerMonth: r.fillsPerMonth, maxDrawdown: r.maxDrawdown }; }),
    winner: winner ? { label: winner.label, cfg: winner.cfg, version: winner.version, lowerBound90: winner.bootstrap.primary.lowerBound90 } : null,
    pboCscv: pbo, recommendation: recommendation,
    validationNote: 'The validation split and --select are NOT run in this build (spec v0.1 §8: selection is not applied until the analysis-thread review of the family+rule is in; the user instructed development-only for this build).'
  });

  var runDir = path.join(RUNS_DIR, rid);
  ensureDir(runDir);
  var tableBody = JSON.stringify(doc, null, 1);
  fs.writeFileSync(path.join(runDir, 'development-table.json'), tableBody);
  fs.writeFileSync(path.join(runDir, 'development-table.sha256'), sha256Hex(Buffer.from(tableBody, 'utf8')));
  return { runId: rid, runDir: runDir, doc: doc };
}

// ---- deliverable 1/5: contaminated-window replay (report only + fixture cross-check hook; N0 by default) ----
function runContaminated(policyLabel) {
  var universe = loadUniverse();
  var fam = buildPolicyFamily();
  var policy = fam.eligibleFamily.filter(function (p) { return p.label === (policyLabel || 'N0'); })[0];
  if (!policy) throw new Error('unknown policy label ' + policyLabel);
  var dates = dateRange(CONTAM_START, CONTAM_END);
  var episodeOpensByDate = {}, candidateCountByDate = {};
  var books = simulateFamily(universe, dates, [policy], function () { return true; }, null, function (dt, shared) {
    episodeOpensByDate[dt] = shared.episodeDays.filter(function (ed) { return ed.opening; }).map(function (ed) { return ed.cgId; });
    candidateCountByDate[dt] = shared.candidates.length;
  });
  var st = statsForPolicy(books[policy.label], policy.id, dates);
  var bs = bootstrapReportFor(st, SEED, PRIMARY_B);
  var orderIssues = books[policy.label].attempts.filter(function (a) { return a.policyId === policy.id; }).map(function (a) { return { date: a.date, cgId: a.cgId, outcome: a.outcome }; });
  var doc = runHeader(universe, {
    kind: 'contaminated-window', label: 'CONTAMINATED (spec §1/§8): replayed for continuity only, never used for selection',
    split: { start: CONTAM_START, end: CONTAM_END }, policy: { label: policy.label, id: policy.id, cfg: policy.cfg },
    stats: { issued: st.issued, filled: st.filled, exited: st.exited, exitReasons: st.exitReasons, funnel: st.funnel,
      meanBudgetR: st.meanBudgetR, medianBudgetR: st.medianBudgetR, maxDrawdown: st.maxDrawdown, suspended: st.suspended },
    bootstrap: bs, episodeOpensByDate: episodeOpensByDate, orderIssues: orderIssues,
    fixtureCrossCheck: 'See handoff: radar_tools/fixtures/data/<month>/<date>.json in the docs folder is the 4-day GRID detection pass only (fields: cgId/symbol/ohlc/detection) — it carries no research/episode/order data, so it cannot be diffed against this window\'s episode-opens/order-issues. No daily forward-pipeline ledger fixture (episodes.json/orders.json) for 2026-06-16..2026-09-16 was found in the docs folder; this section reports the replay\'s own numbers for Ryan/Astra to cross-check against whatever forward generation history is available elsewhere.'
  });
  var runDir = path.join(RUNS_DIR, 'contaminated-' + policy.label);
  ensureDir(runDir);
  writeJson(path.join(runDir, 'contaminated-report.json'), doc);
  return { runDir: runDir, doc: doc };
}

// ---- deliverable 7: --select. IMPLEMENTED, NEVER INVOKED by this build (v0.1 §8 / user instruction). ----
function assertDevelopmentTableWritten(runDir) {
  var tablePath = path.join(runDir, 'development-table.json'), hashPath = path.join(runDir, 'development-table.sha256');
  if (!fs.existsSync(tablePath) || !fs.existsSync(hashPath)) throw new Error('REFUSED: ' + tablePath + ' and its .sha256 must exist on disk before --select or the validation split may run. Run --dev first.');
  var content = fs.readFileSync(tablePath, 'utf8'), recorded = fs.readFileSync(hashPath, 'utf8').trim(), actual = sha256Hex(Buffer.from(content, 'utf8'));
  if (actual !== recorded) throw new Error('REFUSED: ' + tablePath + ' has changed since its hash was recorded (expected ' + recorded + ', got ' + actual + ').');
  return JSON.parse(content);
}
function selectC1(runDir) {
  var table = assertDevelopmentTableWritten(runDir);
  var winner = table.winner;
  var record = { runId: table.runId, selectionRule: table.selectionRule, developmentRanking: table.developmentRanking, winner: winner,
    pboCscv: table.pboCscv, recommendation: table.recommendation, note: 'Selection record only. Per v0.1 §8 this is never applied to the forward cohort until the analysis-thread review of the family and rule is in.' };
  var selDir = path.join(path.dirname(assertDevelopmentTableWrittenPath(runDir)), 'selection-record.json');
  writeJson(selDir, record);
  return record;
}
function assertDevelopmentTableWrittenPath(runDir) { return path.join(runDir, 'development-table.json'); }
// Validation-split guard only (the split itself is out of scope for this build; see the handoff).
function runValidationGuard(runDir) {
  assertDevelopmentTableWritten(runDir);
  throw new Error('The validation split is not implemented in this build (out of scope per the build instructions: development-only, v0.1 selection not yet applied). This function exists so the anti-leakage refusal above is real and testable.');
}

module.exports.internal = { sha256Hex, stableStringify, sha256Of, ymdToSec, secToYmd, addDays, dateRange, computeStore, normSym, slugPair,
  usableSlice, captureFor, researchRowOf, GATE_IDS, MIN_CANDLES_FOR_FIT, sharedDayStep, policyDayStep, buildPolicyFamily, subsetsOf,
  simulateFamily, applyTargetOverride, splitmix32Next, makeXoshiro128ss, goldenVector, drawIndex, blockResampleIndices, percentileBound,
  bootstrapMeanBudgetR, combinations, pboCscv, statsForPolicy, bootstrapReportFor, CONTEXT_DIFFERENCES, fillsPerMonthAvg,
  DEV_START, DEV_END, EMBARGO_END, CONTAM_START, CONTAM_END, SEED, PRIMARY_B, ENGINE_VERSION, gitBlobSha1, verifyPinnedCache };
module.exports.runDevelopment = runDevelopment;
module.exports.runContaminated = runContaminated;
module.exports.selectC1 = selectC1;
module.exports.assertDevelopmentTableWritten = assertDevelopmentTableWritten;
module.exports.runValidationGuard = runValidationGuard;

// ---- CLI ----
function main() {
  var argv = process.argv.slice(2);
  try {
    if (argv.indexOf('--build-store') >= 0) { buildStore(); return; }
    if (argv.indexOf('--dev') >= 0) {
      var res = runDevelopment();
      console.log('development run written:', res.runDir);
      console.log('runId', res.runId, 'winner', res.doc.winner && res.doc.winner.label, 'recommendation', res.doc.recommendation);
      return;
    }
    if (argv.indexOf('--contaminated') >= 0) {
      var pi = argv.indexOf('--policy'), label = pi >= 0 ? argv[pi + 1] : 'N0';
      var cres = runContaminated(label);
      console.log('contaminated-window run written:', cres.runDir);
      return;
    }
    if (argv.indexOf('--select') >= 0) {
      var si = argv.indexOf('--select'), runDir = argv[si + 1];
      if (!runDir) throw new Error('--select requires a run directory argument');
      var rec = selectC1(path.resolve(runDir));
      console.log('selection record written; winner:', rec.winner && rec.winner.label);
      return;
    }
    if (argv.indexOf('--validation') >= 0) {
      var vi = argv.indexOf('--validation'), vRunDir = argv[vi + 1];
      runValidationGuard(path.resolve(vRunDir));
      return;
    }
    console.log('Usage: node replay-driver.js --build-store | --dev | --contaminated [--policy LABEL] | --select <runDir> | --validation <runDir>');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports.buildStore = buildStore;
module.exports.loadMetadataSnapshot = loadMetadataSnapshot;
module.exports.loadUniverse = loadUniverse;
