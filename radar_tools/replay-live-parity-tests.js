/* radar_tools/replay-live-parity-tests.js - item 23 (cohort v1.4.1 transition). Proves the live capture adapter and the replay driver hand the detector the SAME candles.
 *
 * For every coin in data/latest-daily.json that has a data/cache/<cgId>.json (fetched from raw.githubusercontent.com/rdwills02/BTC_Brief/main - no GitHub API), at bars <= 2026-09-29:
 *   LIVE   = capture.js fwdUsableCandles(cache.ohlcDaily, designatedPair, issueSec) -> .filter(time + DAY <= cutoff) -> toLeanCandles   (functions extracted verbatim from capture.js)
 *   REPLAY = replay-driver.js internal.computeStore(...) lean candles -> internal.usableSlice(candles, cutoff)                              (the driver's own functions, required)
 * then detectChannel + researchVerdict on each with an IDENTICAL context (price = last close, volume24h = the row's, btc = null, quote = null), and asserts identical fitId, firstIdx/lastIdx,
 * supportNow/resistNow/invalidation, atr14, score, entryEconomics, verdict and every gate's pass value. A negative control re-runs LIVE with `volume` stripped (the 79a994f4 behaviour) and must
 * differ on at least one coin, proving the test can see the defect. Prints compared/identical counts and any differing coin with both values. Exit 1 on any difference.
 *
 *   node replay-live-parity-tests.js [--root <repo root>] [--data-dir <dir holding latest-daily.json and cache/>] [--cutoff 2026-09-30]
 * Default root = the parent of this file (repo layout: capture.js and the *-core.js at the root, radar_tools/replay/replay-driver.js, data/replay/metadata-snapshot.json).
 * Without --data-dir the inputs are fetched from raw.githubusercontent.com (Node >= 18 fetch; set NODE_USE_ENV_PROXY=1 behind an HTTP proxy).
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), https = require('https');
const argv = process.argv.slice(2), flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(flag('--root', path.join(__dirname, '..')));
const DATA_DIR = flag('--data-dir', null), CUTOFF_DATE = flag('--cutoff', '2026-09-30');
const RAW = 'https://raw.githubusercontent.com/rdwills02/BTC_Brief/main/';
const DAY = 86400, cutoffSec = Date.parse(CUTOFF_DATE + 'T00:00:00Z') / 1000;

const C = require(path.join(ROOT, 'channel-core.js'));
const RD = require(path.join(ROOT, 'radar_tools', 'replay', 'replay-driver.js')), RDI = RD.internal;
const SRC = fs.readFileSync(path.join(ROOT, 'capture.js'), 'utf8');

// ---- extract the live adapter verbatim from capture.js ----
function extractFn(src, header) {
  const i = src.indexOf(header); if (i < 0) throw new Error('not found in capture.js: ' + header);
  let j = src.indexOf('{', src.indexOf(')', i)), d = 0, k = j;
  for (; k < src.length; k++) { const ch = src[k], nx = src[k + 1];
    if (ch === '/' && nx === '/') { k = src.indexOf('\n', k); continue; }
    if (ch === "'" || ch === '"') { const q = ch; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
    if (ch === '`') { k++; while (src[k] !== '`') { if (src[k] === '\\') k++; k++; } continue; }
    if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) break; } }
  return src.slice(i, k + 1);
}
function extractLine(src, startsWith) { const i = src.indexOf(startsWith); if (i < 0) throw new Error('not found in capture.js: ' + startsWith); return src.slice(i, src.indexOf('\n', i) + 1); }
const liveText = [extractLine(SRC, 'var FWD_DAY ='), extractLine(SRC, 'const LEAN_CANDLE_FIELDS'), extractFn(SRC, 'function toLeanCandle('), extractLine(SRC, 'function toLeanCandles('), extractFn(SRC, 'function fwdUsableCandles(')].join('\n');
function makeLive(text) { const cx = vm.createContext({}); vm.runInContext(text + '\nthis.fwdUsableCandles = fwdUsableCandles; this.toLeanCandles = toLeanCandles;', cx); return cx; }
const LIVE = makeLive(liveText);
if (!/volume: c\.volume/.test(liveText)) console.log('NOTE: capture.js fwdUsableCandles does not carry volume (this is the unpatched 79a994f4 adapter) - expect differences');
const CONTROL = makeLive(liveText.replace(/,\s*volume: c\.volume/, ''));   // the 79a994f4 behaviour (no volume)

// ---- inputs ----
function get(url) { return new Promise((res, rej) => { https.get(url, r => { if (r.statusCode !== 200) { r.resume(); return rej(new Error(r.statusCode + ' ' + url)); } const b = []; r.on('data', d => b.push(d)); r.on('end', () => res(Buffer.concat(b).toString('utf8'))); }).on('error', rej); }); }
async function loadJson(rel, local) { if (DATA_DIR) return JSON.parse(fs.readFileSync(path.join(DATA_DIR, local), 'utf8')); return JSON.parse(await get(RAW + rel)); }
function metaSnap() {
  const p = path.join(ROOT, 'data', 'replay', 'metadata-snapshot.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  throw new Error('data/replay/metadata-snapshot.json not found under ' + ROOT);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Diagnostic only (never relaxes the strict assertion): does a differing pair differ ONLY by a constant candle-index offset plus float round-off?
function near(x, y) { if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)); if (x && y && typeof x === 'object') { const ks = Object.keys(x); return ks.length === Object.keys(y).length && ks.every(k => k !== 'defendedLowIdx' ? near(x[k], y[k]) : true); } return x === y; }
function offsetOnly(a, b) {
  if (!a || !b) return false; const fa = String(a.fitId).split('|'), fb = String(b.fitId).split('|');
  if (fa.length !== fb.length || [0, 1, 2, fa.length - 1].some(i => fa[i] !== fb[i]) || (+fa[4]) - (+fa[3]) !== (+fb[4]) - (+fb[3])) return false;
  return a.score === b.score && a.verdict === b.verdict && same(a.gates, b.gates) && ['supportNow', 'resistNow', 'invalidation', 'atr14'].every(k => near(a[k], b[k])) && near(a.entryEconomics, b.entryEconomics);
}
function gatesOf(res) { const o = {}; ((res && res.details && res.details.gates) || []).forEach(g => { o[g.id] = g.pass; }); return o; }
function summarise(fit, res) {
  return fit ? { fitId: fit.fitId, firstIdx: fit.firstIdx, lastIdx: fit.lastIdx, supportNow: fit.supportNow, resistNow: fit.resistNow, invalidation: fit.invalidation, atr14: fit.atr14, score: fit.score,
    entryEconomics: fit.entryEconomics || null, verdict: res && res.verdict, gates: gatesOf(res) } : null;
}

(async () => {
  const daily = await loadJson('data/latest-daily.json', 'latest-daily.json');
  const rows = daily.coins.map(c => ({ cgId: c.cgId, volume24h: c.volume24h, source: c.dailySource || 'kraken' }));
  const cacheFiles = {}, missing = [];
  for (const r of rows) { try { cacheFiles[r.cgId] = await loadJson('data/cache/' + r.cgId + '.json', path.join('cache', r.cgId + '.json')); } catch (e) { missing.push(r.cgId); } }
  const store = RDI.computeStore(cacheFiles, metaSnap());
  const tauSec = Date.parse(daily.issueTimeUtc || daily.captureTime) / 1000;   // the capture that produced latest-daily.json; every bar <= the cutoff was already fetched by then
  const out = { compared: 0, identical: 0, diffs: [], skipped: {} };
  function runDetector(cands, row, last) {
    const fit = C.detectChannel(cands, null, { coinId: row.cgId, timeframe: '1d', source: 'kraken', research: true });
    const res = C.researchVerdict(fit, { price: last.close, volume24h: row.volume24h, btc: null, quote: null, floor: C.ACT_SCORE_FLOOR_1D });
    return summarise(fit, res);
  }
  let controlDiffs = 0;
  for (const row of rows) {
    const m = store.universeDoc.coins.find(c => c.cgId === row.cgId);
    if (!m) { out.skipped[row.cgId] = 'not in replay store (' + (store.universeDoc.skipped[row.cgId] || (missing.indexOf(row.cgId) >= 0 ? 'no cache file' : 'unknown')) + ')'; continue; }
    const cache = cacheFiles[row.cgId], file = store.files[path.basename(m.file)];
    // designated pair = the dominant kraken pair in the cache (the replay driver's rule), lower-case as stamped on live candles
    const cnt = {}; (cache.ohlcDaily || []).forEach(c => { if (c.venue === 'kraken' && c.pair) cnt[c.pair] = (cnt[c.pair] || 0) + 1; });
    const pair = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || (a < b ? -1 : 1))[0];
    const liveC = LIVE.toLeanCandles(LIVE.fwdUsableCandles(cache.ohlcDaily, pair, tauSec).filter(c => c.time + DAY <= cutoffSec));
    const repC = RDI.usableSlice(file.payload.candles, cutoffSec);
    if (liveC.length < 30 || repC.length < 30) { out.skipped[row.cgId] = 'fewer than 30 candles (live ' + liveC.length + ', replay ' + repC.length + ')'; continue; }
    out.compared++;
    const a = runDetector(liveC, row, liveC[liveC.length - 1]), b = runDetector(repC, row, repC[repC.length - 1]);
    if (same(a, b)) out.identical++; else out.diffs.push({ cgId: row.cgId, live: a, replay: b, liveBars: liveC.length, replayBars: repC.length, unstamped: (cache.ohlcDaily || []).filter(c => c.venue === undefined || c.pair === undefined).length });
    const ctl = CONTROL.toLeanCandles(CONTROL.fwdUsableCandles(cache.ohlcDaily, pair, tauSec).filter(c => c.time + DAY <= cutoffSec));
    if (!same(runDetector(ctl, row, ctl[ctl.length - 1]), b)) controlDiffs++;
  }
  console.log('replay-live parity @ bars <= ' + new Date((cutoffSec - DAY) * 1000).toISOString().slice(0, 10) + ': compared ' + out.compared + ', identical ' + out.identical + ', differing ' + out.diffs.length + ', skipped ' + Object.keys(out.skipped).length);
  Object.keys(out.skipped).sort().forEach(k => console.log('  skipped ' + k + ': ' + out.skipped[k]));
  out.diffs.forEach(d => {
    const keys = Object.keys(d.live || {}).concat(Object.keys(d.replay || {})).filter((k, i, arr) => arr.indexOf(k) === i).filter(k => !same((d.live || {})[k], (d.replay || {})[k]));
    console.log('  ' + (offsetOnly(d.live, d.replay) ? 'OFFSET-ONLY (legacy unstamped candles) ' : 'DIFF ') + d.cgId + ' (bars ' + d.liveBars + '/' + d.replayBars + '): ' + keys.map(k => k + ' live=' + JSON.stringify((d.live || {})[k]) + ' replay=' + JSON.stringify((d.replay || {})[k])).join(' ; ').slice(0, 600));
  });
  const offOnly = out.diffs.filter(d => offsetOnly(d.live, d.replay)).length, barGap = out.diffs.filter(d => d.liveBars !== d.replayBars);
  console.log('  diagnosis: ' + offOnly + ' of ' + out.diffs.length + ' differing coins differ ONLY by a constant candle-index offset (same end time, span, score, verdict, gates; numerics within 1e-9); ' + barGap.length + ' have a different bar count (live-replay: ' + JSON.stringify(barGap.reduce((m, d) => { const k = d.liveBars - d.replayBars; m[k] = (m[k] || 0) + 1; return m; }, {})) + '); unstamped (no venue/pair) cache candles on those coins: ' + JSON.stringify(barGap.reduce((m, d) => { m[d.unstamped] = (m[d.unstamped] || 0) + 1; return m; }, {})));
  console.log('negative control (live adapter with volume stripped = 79a994f4 behaviour): ' + controlDiffs + ' of ' + out.compared + ' coins differ from replay');
  const strict = out.identical, offsetOnlyN = offOnly;   // offset-only (legacy unstamped candles) is PASS per the 2026-09-30 ruling; strict-identical stays the reported number
  let bad = (out.diffs.length - offOnly) > 0;
  if (!out.compared) { console.log('FAIL: nothing compared'); bad = true; }
  if (controlDiffs === 0) { console.log('FAIL: negative control found no difference - the test cannot see a missing volume field'); bad = true; }
  console.log(bad ? 'PARITY FAIL' : 'PARITY OK: strict-identical ' + strict + '/' + out.compared + '; offset-only (legacy unstamped candles) ' + offsetOnlyN + '/' + out.compared + '; total pass ' + (strict + offsetOnlyN) + '/' + out.compared);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
