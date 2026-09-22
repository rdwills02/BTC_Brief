/* capture.js — scheduled data-capture pipeline. Writes data/<month>/<D>.json (4-day grid),
 * data/latest.json, data/daily/<D>.json + data/latest-daily.json (daily-basis stream), and
 * data/capture-manifest.json (H8). Run by the GitHub Action (capture.yml); also runnable
 * locally (node capture.js) against the same data/ tree for testing.
 *
 * See RADAR STATE for the full pipeline write-up. This header intentionally stays terse —
 * inline comments carry the reasoning at each step, especially around F1/F2/H7/H8/R3b/R1-R3
 * (Remediation spec, 2026-09-21/22) and the F2 migration logic further down.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./channel-core.js');
const K = require('./cache-core.js');
const EX = require('./exchange-ohlcv.js');
const X = require('./exchange-map.js');

const DATA_DIR = path.join(__dirname, 'data');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const BACKFILL_CANDLES = 4;

const DAY_SECONDS = 86400;
const GRID_SPAN_SECONDS = 4 * DAY_SECONDS;
const CANDLE_SCHEMA_VERSION = 1;

// R3b (Remediation spec): daily-basis ratio-stability + collision-detection thresholds.
const RATIO_MAX_POINTS = 90;
const RATIO_MIN_POINTS = 60;
const RATIO_ROBUST_ACCEPT = 0.055;
const RATIO_ROBUST_REJECT = 0.12;
const COLLISION_FAILOPEN_RATE = 0.10;
const COLLISION_FAILOPEN_MIN_SAMPLE = 5;

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

// H1: drop any bar whose OWN interval hasn't fully elapsed as of `nowSec` — never trust a
// provider's own "closed" framing, since providers differ on whether the newest bar is the
// current in-progress candle or the last fully-closed one.
function isBarClosed(bar, spanSeconds, nowSec) { return (bar.time + spanSeconds) <= nowSec; }
function dropUnclosedBars(bars, spanSeconds, nowSec) {
  return bars.filter(function(b) { return isBarClosed(b, spanSeconds, nowSec); });
}

// H7 (candle half): stamps the full candle contract onto each bar — venue, pair, timeframe,
// span, provider-timestamp semantics, fetchedAt — WITHOUT mutating the input array (clones).
function stampCandleContract(bar, meta) {
  return Object.assign({}, bar, {
    venue: meta.venue, pair: meta.pair, timeframe: meta.timeframe,
    spanSeconds: meta.spanSeconds, providerTimestampMeans: meta.providerTimestampMeans,
    fetchedAt: meta.fetchedAt, candleSchemaVersion: CANDLE_SCHEMA_VERSION
  });
}
function stampCandleContractAll(bars, meta) {
  return bars.map(function(b) { return stampCandleContract(b, meta); });
}

// Strips the H7 candle-contract fields back down to the lean {time,open,high,low,close,date}
// shape channel-core.js's detectors expect — detection never needs venue/pair/etc.
function toLeanCandle(c) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, date: c.date };
}
function toLeanCandles(bars) { return (bars || []).map(toLeanCandle); }

// R3b: sanity-checks a freshly-fetched exchange daily price against the CoinGecko reference
// price for the same coin — catches a wrong-pair fetch (symbol collision) before it ever
// reaches detection. Returns true when within a generous band, false otherwise.
function priceSanityCheck(exchangePrice, cgPrice) {
  if (!exchangePrice || !cgPrice) return false;
  const ratio = exchangePrice / cgPrice;
  return ratio > 0.5 && ratio < 2.0;
}

// R3b: two date strings are "aligned" when they're the same calendar day or adjacent (handles
// exchange/CoinGecko day-boundary skew near midnight UTC).
function datesLookAligned(d1, d2) {
  if (!d1 || !d2) return false;
  const diff = Math.abs(Date.parse(d1 + 'T00:00:00Z') - Date.parse(d2 + 'T00:00:00Z'));
  return diff <= DAY_SECONDS * 1000;
}

function median(arr) {
  const s = arr.slice().sort(function(a, b) { return a - b; });
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// R3b: robust ratio-stability check between an exchange daily series and the CoinGecko
// reference series over the same window — the core symbol-collision guard. Computes the
// per-day price ratio (exchange/CoinGecko) across up to RATIO_MAX_POINTS matched days (at
// least RATIO_MIN_POINTS required to judge), then measures the median absolute deviation of
// those ratios from their own median (a robust dispersion measure, insensitive to a few
// outlier days). ACCEPT when that spread is under RATIO_ROBUST_ACCEPT, REJECT when over
// RATIO_ROBUST_REJECT, and an explicit UNCERTAIN band between them — callers apply the
// fail-open collision policy (COLLISION_FAILOPEN_RATE/MIN_SAMPLE) only in that band.
function ratioStabilityCheck(exchangeSeries, cgSeries) {
  const cgByDate = {};
  for (const c of cgSeries) cgByDate[c.date] = c.close;
  const ratios = [];
  for (const e of exchangeSeries) {
    const cgClose = cgByDate[e.date];
    if (cgClose == null || !cgClose) continue;
    ratios.push(e.close / cgClose);
    if (ratios.length >= RATIO_MAX_POINTS) break;
  }
  if (ratios.length < RATIO_MIN_POINTS) return { verdict: 'insufficient', n: ratios.length, mad: null };
  const med = median(ratios);
  const devs = ratios.map(function(r) { return Math.abs(r - med); });
  const mad = median(devs);
  let verdict;
  if (mad < RATIO_ROBUST_ACCEPT) verdict = 'accept';
  else if (mad > RATIO_ROBUST_REJECT) verdict = 'reject';
  else verdict = 'uncertain';
  return { verdict: verdict, n: ratios.length, mad: mad };
}

// R3b: per-run symbol-collision bookkeeping. detectSymbolCollision is called once per coin
// (best-effort — never throws); resolveDailyCollisions is called once after the whole universe
// is pulled, applying the fail-open policy using the AGGREGATE collision rate this run saw.
function detectSymbolCollision(pulled, exMeta) {
  if (!exMeta || !pulled.dailyCandles || !pulled.dailyCandles.length) return null;
  const check = ratioStabilityCheck(pulled.dailyCandles, pulled.candles);
  return { symbol: pulled.coin.symbol, cgId: pulled.coin.id, exVenue: exMeta.venue, exPair: exMeta.pair, check: check };
}
function resolveDailyCollisions(pulls) {
  const withChecks = pulls.filter(function(p) { return p.collisionCheck; });
  const uncertainOrReject = withChecks.filter(function(p) {
    return p.collisionCheck.check.verdict === 'uncertain' || p.collisionCheck.check.verdict === 'reject';
  });
  const totalChecked = withChecks.length;
  const flaggedRate = totalChecked ? uncertainOrReject.length / totalChecked : 0;
  const failOpen = flaggedRate <= COLLISION_FAILOPEN_RATE || totalChecked < COLLISION_FAILOPEN_MIN_SAMPLE;
  for (const p of pulls) {
    if (!p.collisionCheck) continue;
    const v = p.collisionCheck.check.verdict;
    if (v === 'reject') { p.dailySource = 'coingecko-4d-fallback'; p.dailyCandles = p.candles; continue; }
    if (v === 'uncertain' && !failOpen) { p.dailySource = 'coingecko-4d-fallback'; p.dailyCandles = p.candles; continue; }
    // accept, or uncertain-but-failing-open: keep the exchange daily series as pulled.
  }
  console.log('R3b collision resolution: ' + totalChecked + ' checked, ' + uncertainOrReject.length +
    ' uncertain/reject (' + (100 * flaggedRate).toFixed(1) + '%), fail-open=' + failOpen);
}

// Builds one grid-row (4-day) for a coin at a specific candle index.
function rowForCandle(pulled, idx, catLabels, diag) {
  const coin = pulled.coin;
  const upto = pulled.candles.slice(0, idx + 1);
  const c = pulled.candles[idx];
  const det = C.detectChannel(toLeanCandles(upto), diag, { coinId: coin.id, timeframe: '4d-grid', source: pulled.gridSource || 'coingecko' });
  return {
    cgId: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.market_cap_rank,
    price: c.close, change24h: coin.price_change_percentage_24h != null ? coin.price_change_percentage_24h : null,
    volume24h: coin.total_volume != null ? coin.total_volume : null,
    marketCap: coin.market_cap != null ? coin.market_cap : null,
    category: catLabels[coin.id] || null,
    detection: det
  };
}

// Builds the fetch/normalize pipeline for one coin — pulled ONCE per run, feeding both the
// 4-day grid pass and the daily-basis pass below.
async function pullCoin(coin, exMeta, nowSec) {
  try {
    const raw = await K.fetchAndCacheOhlc(CACHE_DIR, coin.id);
    if (!raw || !raw.length) return null;
    const candles = dropUnclosedBars(raw, GRID_SPAN_SECONDS, nowSec);
    let dailyCandles = null, dailySource = 'coingecko-4d-fallback', collisionCheck = null;
    if (exMeta) {
      try {
        const exRaw = (exMeta.venue === 'kraken') ? await EX.fetchKrakenDaily(exMeta.pair) : await EX.fetchCoinbaseDaily(exMeta.pair);
        const exClosed = dropUnclosedBars(exRaw, DAY_SECONDS, nowSec);
        if (exClosed.length) {
          let cache = K.loadCache(CACHE_DIR, coin.id) || K.emptyCache(coin.id, coin.symbol);
          const stamped = stampCandleContractAll(exClosed, {
            venue: exMeta.venue, pair: exMeta.pair, timeframe: '1d',
            spanSeconds: DAY_SECONDS, providerTimestampMeans: 'open', fetchedAt: new Date().toISOString()
          });
          K.mergeOhlcDailyCandles(cache, stamped);
          K.saveCache(CACHE_DIR, cache);
          dailyCandles = (cache.ohlcDaily || []).map(toLeanCandle);
          dailySource = exMeta.venue;
        }
      } catch (e) {
        console.warn('exchange daily pull failed for', coin.id, '— falling back to CoinGecko-4d:', e.message);
      }
    }
    if (!dailyCandles) {
      let cache = K.loadCache(CACHE_DIR, coin.id);
      dailyCandles = (cache && cache.ohlcDaily && cache.ohlcDaily.length) ? cache.ohlcDaily.map(toLeanCandle) : candles;
    }
    const pulled = { coin: coin, candles: candles, dailyCandles: dailyCandles, dailySource: dailySource, gridSource: 'coingecko' };
    if (exMeta && dailySource !== 'coingecko-4d-fallback') {
      pulled.collisionCheck = detectSymbolCollision(pulled, exMeta);
    }
    return pulled;
  } catch (e) {
    console.warn('pullCoin failed for', coin.id, ':', e.message);
    return null;
  }
}

// Builds the daily-basis row for one coin (upgrade #2, 2026-09-17): parallel to rowForCandle
// above but always sliced to the coin's FULL daily series (not a specific 4-day grid date).
function rowForDaily(pulled, catLabels, diag) {
  const coin = pulled.coin;
  const dailyCandles = pulled.dailyCandles;
  const dailySource = pulled.dailySource;
  const base = {
    cgId: coin.id, symbol: coin.symbol, name: coin.name, rank: coin.market_cap_rank,
    price: coin.current_price != null ? coin.current_price : null,
    change24h: coin.price_change_percentage_24h != null ? coin.price_change_percentage_24h : null,
    volume24h: coin.total_volume != null ? coin.total_volume : null,
    marketCap: coin.market_cap != null ? coin.market_cap : null,
    category: catLabels[coin.id] || null,
    dailySource: dailySource
  };
  if (!dailyCandles || dailyCandles.length < 30) return Object.assign(base, { detectionDaily: null });
  // H7: same meta stamping as the grid pass; source here is whatever venue this coin's daily
  // stream actually came from this run (kraken/coinbase/coingecko-4d-fallback/etc).
  // FIX (BLOCKS finding, 2026-09-22): this is the REAL structural leak point — `dailyCandles`
  // here (pulled.dailyCandles) can be `p.cache.ohlcDaily`, i.e. H7-ENRICHED candles either
  // freshly merged this run or reloaded from an already-enriched on-disk cache file from a
  // PRIOR run — cloning-not-mutating upstream (pullCoin) does nothing to address that second
  // case. toLeanCandles() here strips it regardless of provenance, so detectionDaily.candles
  // (written into data/daily/*.json and latest-daily.json) is provably lean every run.
  const det = C.detectChannel(toLeanCandles(dailyCandles), diag, { coinId: coin.id, timeframe: '1d', source: dailySource });
                                                // SAME shared detection as the 4-day pass —
                                                // no separate scoring logic, no write-time
                                                // score filter (see header).
  return Object.assign(base, { detectionDaily: det });
}

// dataDir defaults to the module DATA_DIR; every call in main() below omits it. The override
// exists ONLY so the F2-migration logic below can be unit-tested against a real temp directory
// instead of the live data/ tree — see step1-invariant-tests.js.
function dayFilePath(D, dataDir) {
  const month = D.slice(0, 7);
  return path.join(dataDir || DATA_DIR, month, D + '.json');
}
function dayFileExists(D, dataDir) { return fs.existsSync(dayFilePath(D, dataDir)); }
function writeDayFile(D, obj, dataDir) {
  const p = dayFilePath(D, dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 0));
  console.log('wrote', p, '(' + obj.coins.length + ' coins, backfilled=' + obj.backfilled + ')');
}

// --- Remediation F2 migration (added per 2026-09-22 review — BLOCKS finding): every day file
// written before this fix is CLOSE-stamped (named/dated by the candle's close, per the original
// CoinGecko-timestamp bug F2 fixes). Every day file written after this fix is OPEN-stamped. The
// two conventions' filenames COLLIDE (new-label(candle_k) === old-label(candle_{k-1}), since
// candles are a fixed 4 days apart under both conventions) — without this, `dayFileExists(D)`
// would treat an old, differently-dated candle's file as "D already captured", silently
// skipping the real D and regressing `latest.json` to stale/mislabeled data forever (see the
// review's traced run-by-run walkthrough). `gridStamp: 'open'` marks every NEW-convention
// payload; its absence marks a legacy file. A legacy file found at a date the new run needs is
// migrated in place — deep-shifted by -GRID_SPAN_SECONDS (top-level date, every row's date,
// every row's detection.candles[]/pivotLows[] time+date, since those came from the same
// close-stamped candles array as everything else the OLD code wrote) and moved to its own
// correct open-stamped filename — before the real D is captured fresh. This does not migrate
// the FULL data/ tree in one shot: only files the write loop actually revisits (bounded by
// BACKFILL_CANDLES, currently the newest ~4 grid dates) get migrated, run by run, as capture.js
// naturally walks forward. Filed as BACKLOG (see handoff): older files outside that window stay
// close-stamped until something else (the step-5 harness, or a one-time batch pass) processes
// them — they are not touched by main()'s write loop, so they don't collide with anything.
function isOpenStampPayload(obj) { return !!(obj && obj.gridStamp === 'open'); }

function readDayFilePayload(D, dataDir) {
  if (!dayFileExists(D, dataDir)) return null;
  try { return JSON.parse(fs.readFileSync(dayFilePath(D, dataDir), 'utf8')); } catch (e) { return null; }
}

// Deep-shifts every GRID-candle date/time field in a legacy payload by -shiftSeconds. Never
// mutates its input. `ymdSec` mirrors the module's own `ymd()` but takes seconds (candle `time`
// fields are stored in seconds throughout this file; ymd() itself takes ms).
function ymdSec(sec) { return ymd(sec * 1000); }
function shiftGridPayloadDates(payload, shiftSeconds) {
  const migrated = JSON.parse(JSON.stringify(payload));
  function shiftCandleLike(c) {
    if (c && typeof c.time === 'number') { c.time -= shiftSeconds; c.date = ymdSec(c.time); }
  }
  if (typeof migrated.date === 'string') {
    migrated.date = ymdSec(Math.floor(Date.parse(migrated.date + 'T00:00:00Z') / 1000) - shiftSeconds);
  }
  for (const row of (migrated.coins || [])) {
    if (typeof row.date === 'string') {
      row.date = ymdSec(Math.floor(Date.parse(row.date + 'T00:00:00Z') / 1000) - shiftSeconds);
    }
    const det = row.detection;
    if (det) {
      if (Array.isArray(det.candles)) det.candles.forEach(shiftCandleLike);
      if (Array.isArray(det.pivotLows)) det.pivotLows.forEach(shiftCandleLike);
    }
  }
  return migrated;
}

// Migrates exactly ONE legacy (close-stamped) file to its corrected open-stamped filename.
// NEVER deletes captured data in favor of anything — this is a pure RELABEL-AND-RELOCATE:
// shiftGridPayloadDates only touches date/time fields, so captured_at, change24h, volume24h,
// price, detection — every point-in-time field the original capture recorded — survives
// unchanged. If the corrected path is already occupied by anything at all, this backs off
// loudly and leaves the legacy file exactly where it is, untouched, for a human to look at —
// it never overwrites or drops existing data to resolve a collision. See
// migrateAllLegacyDayFiles below for why, called oldest-first, this essentially never collides
// on the real data.
function migrateOneLegacyDayFile(legacyDate, dataDir) {
  const legacyPath = dayFilePath(legacyDate, dataDir);
  if (!fs.existsSync(legacyPath)) return;   // already moved by an earlier step this pass
  let legacyPayload;
  try { legacyPayload = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
  catch (e) { console.warn('F2 migration: unreadable file at', legacyDate, '- leaving it in place untouched.'); return; }
  if (isOpenStampPayload(legacyPayload)) return;   // already migrated — nothing to do

  const correctedDate = ymdSec(Math.floor(Date.parse(legacyDate + 'T00:00:00Z') / 1000) - GRID_SPAN_SECONDS);
  const correctedPath = dayFilePath(correctedDate, dataDir);
  if (fs.existsSync(correctedPath)) {
    console.warn('F2 migration: corrected path for legacy', legacyDate, 'would be', correctedDate,
      'but a file already exists there — leaving', legacyDate, 'exactly as captured, untouched.',
      'Never auto-deleting captured data to resolve this; needs a manual look.');
    return;
  }
  const migrated = shiftGridPayloadDates(legacyPayload, GRID_SPAN_SECONDS);
  migrated.gridStamp = 'open';
  migrated.migratedFrom = legacyDate;
  fs.mkdirSync(path.dirname(correctedPath), { recursive: true });
  fs.writeFileSync(correctedPath, JSON.stringify(migrated, null, 0));
  fs.unlinkSync(legacyPath);
  console.log('F2 migration:', legacyDate, '(legacy close-stamp) -> corrected and moved to', correctedDate,
    '- every original captured field preserved, only date/time labels shifted.');
}

// Finds every legacy grid file under dataDir and migrates each exactly once, OLDEST FIRST — run
// as a PRE-PASS, once, before main()'s per-date write loop even starts (2026-09-22 review,
// second pass: the first version of this migrated lazily inside the write loop and, on any
// corrected-path collision, treated an already-open-stamped occupant as "superseded" and
// DELETED the legacy file — which meant a genuinely-captured historical file (including the
// frozen 9/21 audit capture, the exact data the Fable/Astra audit was built against) could be
// unlinked and replaced by a same-run reconstruction built from TODAY's live coin data, silently
// destroying its original point-in-time fields (captured_at, change24h, volume24h — see
// rowForCandle). That is now impossible: migrateOneLegacyDayFile above never deletes anything in
// favor of a fresh write, only a pure relabel. Oldest-first is what makes the real on-disk chain
// (five consecutive legacy dates, each one's corrected target being the PREVIOUS legacy date's
// own current path) resolve cleanly in a single pass with zero collisions: by the time date D is
// processed, D's corrected target (D - 4 days) was already vacated by that earlier, still-older
// date's own move, one date at a time. After this pre-pass, main()'s write loop sees a single,
// clean convention — every file it can find is either open-stamped or genuinely absent — so it
// goes back to a plain "does D's file exist" check; the per-date logic below no longer migrates
// anything itself.
function migrateAllLegacyDayFiles(dataDir) {
  if (!fs.existsSync(dataDir)) return;
  const legacyDates = [];
  for (const month of fs.readdirSync(dataDir)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const monthDir = path.join(dataDir, month);
    if (!fs.statSync(monthDir).isDirectory()) continue;
    for (const file of fs.readdirSync(monthDir)) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const payload = readDayFilePayload(m[1], dataDir);
      if (payload && !isOpenStampPayload(payload)) legacyDates.push(m[1]);
    }
  }
  legacyDates.sort();   // oldest first — see this function's header comment for why this matters
  for (const D of legacyDates) migrateOneLegacyDayFile(D, dataDir);
  if (legacyDates.length) console.log('F2 migration pre-pass: processed', legacyDates.length, 'legacy grid file(s).');
}

async function main() {
  // F2 migration pre-pass (2026-09-22 review): resolve every existing legacy grid file BEFORE
  // any network call or per-date decision — see migrateAllLegacyDayFiles' header comment. Pure
  // filesystem work, so it runs first and cheaply.
  migrateAllLegacyDayFiles(DATA_DIR);

  // F1/F2 (Remediation spec): a single "now" for the whole run, so every closed-bar decision
  // (grid and daily) this run judges against the same instant rather than drifting across the
  // run's several minutes of fetches.
  const nowSec = Math.floor(Date.now() / 1000);

  // H8 (Remediation spec): per-pass run-tracking, threaded through the rest of main() and
  // written into data/capture-manifest.json at the end. "ok" = the pass completed without
  // throwing (best-effort passes keep last-run cache data on failure — see each try/catch —
  // so ok:false does NOT mean the cache went empty, only that THIS run didn't refresh it).
  // "updated" = this run actually wrote/merged something for that pass, not just confirmed
  // nothing new was due. lastClosedCandle = the newest bar date that pass's data reflects,
  // whether from this run or a prior one.
  let gridUpdatedThisRun = false;
  let dailyPassOk = false, dailyUpdatedThisRun = false, dailyLastClosedCandle = null;
  let btcPassOk = false, btcUpdatedThisRun = false, btcLastClosedCandle = null;

  const { list: universe, counts: universeCounts } = await buildUniverse();
  console.log('universe:', universe.length, 'coins');
  if (!universe.length) { console.error('empty universe — aborting, not writing'); process.exit(1); }

  // Display-category labels (context tags). 7 calls.
  const catLabels = await fetchCategoryLabels();
  console.log('category labels for', Object.keys(catLabels).length, 'coins');

  // Exchange ticker map (upgrade #2, 2026-09-17) — 2 calls, rebuilt fresh every run since the
  // universe rotates. Best-effort: a failure here does NOT abort the run — every coin just
  // falls back to CoinGecko-4d for the daily stream (see pullCoin/rowForDaily).
  let exMap = {};
  try {
    exMap = await X.buildExchangeMap(universe.map(c => ({ id: c.id, symbol: c.symbol })));
    console.log('exchange map:', Object.keys(exMap).length, 'of', universe.length, 'coins mapped to Kraken/Coinbase');
  } catch (e) {
    console.warn('exchange-map build failed — every coin falls back to CoinGecko-4d for the daily stream:', e.message);
  }

  // F6 (Remediation spec): capture BTC's own daily series for the future market-regime gate
  // (C5, a later remediation step — this step only captures the data, C5 reads it). Fetched
  // directly against Kraken's XBTUSD pair rather than going through exchange-map/buildExchangeMap
  // — BTC/ETH are excluded from the altcoin universe those functions serve, and exchange-map's
  // generic symbol matching would map 'BTC' to the ticker string 'BTC' (see exchange-map.js's
  // ALIAS table, used only for MATCHING), not Kraken's actual 'XBT' base, which fetchKrakenDaily
  // would then send as the invalid pair 'BTCUSD'. Stored the same way every other coin's daily
  // series is stored (cache-core.js, cgId 'bitcoin' — CoinGecko's id for BTC) so C5 reads it
  // with the exact same K.loadCache() call as everything else, no new storage format. Best-
  // effort: a failure here never aborts the run — same isolation pattern as the per-coin daily
  // pull and the daily-basis-stream block below.
  try {
    const btcRaw = await EX.fetchKrakenDaily('XBT');
    const btcClosed = dropUnclosedBars(btcRaw, DAY_SECONDS, nowSec);   // lean (still carries exchange-ohlcv.js's own `raw`, stripped below)
    // H7: same candle-contract stamp as the per-coin exchange daily pull above.
    // FIX (BLOCKS finding, 2026-09-22): stampCandleContractAll clones, it no longer mutates
    // `btcClosed` in place — capture its return value for the cache merge, and lean-ify
    // `btcClosed` itself so it stays a safe, un-enriched value if a future step (C5) ever
    // detects on it directly.
    const btcCacheCandles = stampCandleContractAll(btcClosed, {
      venue: 'kraken', pair: 'XBT/usd', timeframe: '1d',
      spanSeconds: DAY_SECONDS, providerTimestampMeans: 'open', fetchedAt: new Date().toISOString()
    });
    let btcCache = K.loadCache(CACHE_DIR, 'bitcoin') || K.emptyCache('bitcoin', 'btc');
    K.mergeOhlcDailyCandles(btcCache, btcCacheCandles);
    K.saveCache(CACHE_DIR, btcCache);
    console.log('BTC daily series captured:', btcCache.ohlcDaily.length, 'candles, newest', btcClosed.length ? btcClosed[btcClosed.length - 1].date : '(none this run)');
    btcPassOk = true;
    btcUpdatedThisRun = btcClosed.length > 0;
    btcLastClosedCandle = btcCache.ohlcDaily.length ? btcCache.ohlcDaily[btcCache.ohlcDaily.length - 1].date : null;
  } catch (e) {
    console.warn('BTC daily capture failed (regime gate will have no data until this succeeds):', e.message);
  }

  // Pull each coin's series ONCE.
  const pulls = [];
  for (const coin of universe) {
    const p = await pullCoin(coin, exMap[coin.id], nowSec);
    if (p) pulls.push(p);
  }
  console.log('pulled series for', pulls.length, 'coins');
  if (!pulls.length) { console.error('no coin data pulled — aborting'); process.exit(1); }

  // R3b: resolve every coin's exchange-daily accept/reject decision now that the whole universe
  // has been pulled and the aggregate collision rate is known — see resolveDailyCollisions().
  // Must run before anything below reads p.dailySource/p.dailyCandles (rowForDaily, further down).
  resolveDailyCollisions(pulls);

  // The OHLC grid is every ~4 days. Use a reference coin (most candles) to get the set of
  // recent GRID DATES, then write a file per grid date (newest BACKFILL_CANDLES) if missing.
  // The newest grid date is the latest CLOSED candle — may be up to ~3 days before "today".
  const ref = pulls.reduce((a, b) => (b.candles.length > a.candles.length ? b : a), pulls[0]);
  const gridDates = ref.candles.map(c => c.date);
  const recent = gridDates.slice(-BACKFILL_CANDLES);          // last N grid dates
  const newestGrid = gridDates[gridDates.length - 1];
  console.log('grid dates to consider:', recent.join(', '), '| newest closed candle:', newestGrid);

  let newestPayload = null;
  for (const D of recent) {
    // F2 migration (2026-09-22 review, second pass): migrateAllLegacyDayFiles already ran as a
    // pre-pass before this loop and resolved every legacy file it could — oldest-first, pure
    // relabel-and-relocate, never deleting. So by the time we get here there are exactly three
    // possibilities for D: (1) no file at all - write fresh; (2) an open-stamped file - already
    // captured, skip; (3) a legacy file the pre-pass explicitly backed off on (its corrected
    // target was occupied - see migrateOneLegacyDayFile) - leave it untouched and skip, never
    // overwrite captured data to force this date through. Per the review: "write only dates with
    // no file."
    const existing = readDayFilePayload(D);
    if (existing && isOpenStampPayload(existing)) {
      console.log(D, 'already captured (open-stamp) - skipping');
      continue;
    }
    if (existing && !isOpenStampPayload(existing)) {
      console.warn(D, 'legacy file still present after the migration pre-pass (backed off - see its warning above) - leaving it untouched, skipping this date this run');
      continue;
    }
    const coins = [];
    // Backlog #13 (2026-09-19): per-date funnel tally - fresh diag per grid date, since
    // detectChannel runs on a DIFFERENT candle slice (`upto`) for each date and the gate
    // counts are therefore genuinely date-specific, unlike universeCounts/universe.length
    // above (computed once for the whole run, reused across every date's payload below).
    const diag = { ohlcOk: 0, railPairs: 0, posSlope: 0, touches: 0, containment: 0 };
    for (const p of pulls) {
      const idx = p.candles.findIndex(c => c.date === D);
      if (idx < 0) continue;                                   // coin has no candle on this grid date
      diag.ohlcOk++;                                            // coin has a usable candle on this date
      const row = rowForCandle(p, idx, catLabels, diag);
      if (row) coins.push(row);
    }
    if (!coins.length) { console.log('no coin candles on', D, '- skipping'); continue; }
    const payload = {
      date: D,
      gridStamp: 'open',   // F2 migration marker — see migrateOneLegacyDayFile's header comment
      captured_at: new Date().toISOString(),
      grid_interval_days: 4,
      backfilled: D !== newestGrid,   // only the newest closed candle is "live"; older = backfilled
      universe_count: pulls.length,
      // Backlog #13: the funnel the live Scan's Details panel already computes client-side
      // (radar.html's diag object), now computed here too so CACHED mode (the default view -
      // capture.js drives it, not a live Scan) has real numbers instead of nothing. Deliberately
      // does NOT repeat 'universe' or 'candidates' here - those already have a single source of
      // truth elsewhere (universe_count above; the merged allResults.length client-side) and
      // duplicating them into a second, independently-computed field is exactly the #7 bug
      // class (two reads of the same fact silently able to disagree) applied to a new pair of
      // numbers - see the funnel-consumer code in radar.html for how it's kept to one source.
      funnel: {
        volExcluded: universeCounts.volExcluded,
        catExcluded: universeCounts.catExcluded,
        ohlcOk: diag.ohlcOk,
        railPairs: diag.railPairs,
        posSlope: diag.posSlope,
        touches: diag.touches,
        containment: diag.containment
      },
      coins
    };
    writeDayFile(D, payload);
    gridUpdatedThisRun = true;
    if (D === newestGrid) newestPayload = payload;
  }

  // Maintain data/latest.json -> the newest capture, so radar can load it without dir listing.
  // Always point at the newest grid date; rebuild from its file if we skipped writing it. F2
  // migration (2026-09-22 review): only trust an OPEN-stamped file here — a legacy file that
  // happens to still sit at this path (migration backed off above) must never be published as
  // "the newest capture" under a date that, for it, means something else.
  if (!newestPayload && dayFileExists(newestGrid)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(dayFilePath(newestGrid), 'utf8'));
      if (isOpenStampPayload(candidate)) newestPayload = candidate;
      else console.warn('newestGrid fallback found a legacy (non-open-stamped) file at', newestGrid, '- refusing to publish it as latest.json. The write loop above should have migrated it; investigate.');
    } catch (e) {}
  }
  if (newestPayload) {
    fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(newestPayload, null, 0));
    console.log('wrote data/latest.json ->', newestPayload.date);
  }

  // --- Daily-basis stream (upgrade #2, 2026-09-17): parallel to the 4-day grid above,
  // written EVERY run under today's date, not a grid date. See header for why this is a
  // separate file rather than a field added to the grid files.
  //
  // FAILURE ISOLATION (required — nothing here has touched a live exchange yet, this run IS
  // the first live test): this WHOLE block is wrapped in its own try/catch, deliberately AFTER
  // data/latest.json has already been written above. If anything in here throws — a live
  // Kraken/Coinbase response shape surprise, a detectChannel edge case on real daily candles, a
  // disk error — it is caught, logged, and main() still reaches 'done' with exit code 0. This
  // matters beyond just "don't crash": a non-zero exit here would fail the Action step BEFORE
  // the "Commit captured data" step runs, which would mean the 4-day grid files and
  // data/latest.json — already correctly written to disk above — never get committed at all.
  // Degrading to "no data/daily this run" must never cost the 4-day capture. Per-coin failures
  // are isolated too (see below) so one bad coin can't blank the whole day's daily stream. ---
  try {
    const todayDate = ymd(Date.now());
    // Backlog #13 (2026-09-19): funnel tally for the daily pass - separate from the grid
    // funnel above because it's a genuinely different detection run (different candle source,
    // no independent universe re-filter, so no volExcluded/catExcluded here - this pass reuses
    // the grid pass's already-filtered coin list rather than re-running qualifiesForUniverse).
    const dailyDiag = { ohlcOk: 0, railPairs: 0, posSlope: 0, touches: 0, containment: 0 };
    const dailyCoins = pulls.map(p => {
      try {
        return rowForDaily(p, catLabels, dailyDiag);
      } catch (e) {
        console.warn('rowForDaily failed for', p.coin.id, '— writing a safe fallback row:', e.message);
        return {
          cgId: p.coin.id, symbol: p.coin.symbol, name: p.coin.name, rank: p.coin.market_cap_rank,
          price: p.coin.current_price != null ? p.coin.current_price : null,
          change24h: null, volume24h: null, marketCap: null, category: null,
          dailySource: 'row-error', detectionDaily: null
        };
      }
    });
    // F1 (Remediation spec): so the page can PROVE the last bar it detected on is closed,
    // rather than trust the pipeline. lastBarTime is the newest bar time actually present
    // across every coin's (already closed-bar-filtered, see pullCoin/dropUnclosedBars) daily
    // series feeding this run's detection — not "today", which F1 guarantees is never in
    // there. captureTime is simply when this run executed (todayDate/captured_at already
    // capture that at day resolution; this is the exact instant, for the closed-bar math).
    let lastBarTimeSec = null;
    for (const p of pulls) {
      const arr = p.dailyCandles;
      if (!arr || !arr.length) continue;
      const t = arr[arr.length - 1].time;
      if (lastBarTimeSec === null || t > lastBarTimeSec) lastBarTimeSec = t;
    }
    const dailyPayload = {
      date: todayDate,
      captureTime: new Date(nowSec * 1000).toISOString(),
      lastBarTime: lastBarTimeSec !== null ? new Date(lastBarTimeSec * 1000).toISOString() : null,
      captured_at: new Date().toISOString(),
      universe_count: dailyCoins.length,
      funnel: {
        ohlcOk: dailyDiag.ohlcOk,
        railPairs: dailyDiag.railPairs,
        posSlope: dailyDiag.posSlope,
        touches: dailyDiag.touches,
        containment: dailyDiag.containment
      },
      coins: dailyCoins
    };
    const dailyDayPath = path.join(DAILY_DIR, todayDate + '.json');
    fs.mkdirSync(path.dirname(dailyDayPath), { recursive: true });
    fs.writeFileSync(dailyDayPath, JSON.stringify(dailyPayload, null, 0));
    fs.writeFileSync(path.join(DATA_DIR, 'latest-daily.json'), JSON.stringify(dailyPayload, null, 0));
    const dailyFlagged = dailyCoins.filter(c => c.detectionDaily).length;
    const fallbackOnly = dailyCoins.filter(c => c.dailySource === 'coingecko-4d-fallback').length;
    console.log('wrote', dailyDayPath, 'and data/latest-daily.json ->', todayDate,
      '(' + dailyFlagged + ' daily candidates, ' + fallbackOnly + ' coins on CoinGecko-4d fallback)');
    dailyPassOk = true;
    dailyUpdatedThisRun = true;
    dailyLastClosedCandle = lastBarTimeSec !== null ? new Date(lastBarTimeSec * 1000).toISOString().slice(0, 10) : null;
  } catch (e) {
    console.error('DAILY-BASIS STREAM FAILED this run (4-day capture above is unaffected and will still be committed):', e);
  }

  // --- H8 capture manifest (Remediation spec, 2026-09-21/22) -----------------------------------
  // "Every capture writes source timestamps, last closed candle, fetch completion time, schema
  // version, detector version and a config hash. Failed refreshes keep the last valid data but
  // age it visibly. Refresh states which pass it updated." Written LAST, after every pass above
  // has run (or been caught) — its own file write is wrapped separately so a manifest-write
  // failure can never cost data already committed above (same failure-isolation principle the
  // daily-basis stream already uses).
  //
  // "Failed refreshes keep the last valid data but age it visibly" is satisfied by this manifest
  // EXISTING and being read-able: a pass with ok:false / updated:false alongside an unchanged
  // lastClosedCandle is exactly "aged, visibly" data — a consumer can compare fetchCompletedAt
  // against lastClosedCandle's own date to see staleness. Actually WIRING a consumer (radar.html)
  // to read and display this manifest is NOT done in this step — H8's own text only requires the
  // write. Filed as BACKLOG in the H7/H8 handoff: a future step should surface
  // capture-manifest.json's staleness in the UI (e.g. next to the "cached" data source label).
  try {
    const configHash = crypto.createHash('sha256').update(JSON.stringify({
      PIVOT_LB: C.PIVOT_LB, TOUCH_TOL: C.TOUCH_TOL, ROCKET_CLOSE_TOL: C.ROCKET_CLOSE_TOL,
      FIT_SCHEMA_VERSION: C.FIT_SCHEMA_VERSION, CONTAINMENT_RECENT_WINDOW: C.CONTAINMENT_RECENT_WINDOW,
      DETECTOR_VERSION: C.DETECTOR_VERSION, CANDLE_SCHEMA_VERSION: CANDLE_SCHEMA_VERSION,
      GRID_SPAN_SECONDS: GRID_SPAN_SECONDS, DAY_SECONDS: DAY_SECONDS, BACKFILL_CANDLES: BACKFILL_CANDLES,
      RATIO_ROBUST_ACCEPT: RATIO_ROBUST_ACCEPT, RATIO_ROBUST_REJECT: RATIO_ROBUST_REJECT,
      RATIO_MIN_POINTS: RATIO_MIN_POINTS, RATIO_MAX_POINTS: RATIO_MAX_POINTS,
      COLLISION_FAILOPEN_RATE: COLLISION_FAILOPEN_RATE, COLLISION_FAILOPEN_MIN_SAMPLE: COLLISION_FAILOPEN_MIN_SAMPLE,
      // Step 6 (Remediation spec, 2026-09-21/22; per Step 6 plan review 2026-09-22, §1): the
      // new research-mode detection constants (A1-A5/H9). capture.js itself never calls
      // detectChannel with meta.research (it always captures the flag-off reading - R3 removed
      // the process-level "research mode" concept this comment used to describe as a boolean
      // field here), so these don't change what capture.js writes - they're hashed here purely
      // so any future tuning of them is visible in configHash exactly like every existing
      // detection constant above.
      FIT_WINDOW: C.FIT_WINDOW, FIT_WINDOW_GRID: C.FIT_WINDOW_GRID, BREAK_RUN_MAX: C.BREAK_RUN_MAX,
      RECLAIM_BARS: C.RECLAIM_BARS, MIN_ANCHOR_SPAN: C.MIN_ANCHOR_SPAN,
      MIN_ANCHOR_SPAN_GRID: C.MIN_ANCHOR_SPAN_GRID, MIN_TOUCH_GAP: C.MIN_TOUCH_GAP,
      TOUCH_TOL_ATR_MULT: C.TOUCH_TOL_ATR_MULT, TOUCH_TOL_MIN: C.TOUCH_TOL_MIN, TOUCH_TOL_MAX: C.TOUCH_TOL_MAX,
      // Step 7 (Remediation spec, 2026-09-21/22; per Step 7 plan review 2026-09-22): the new
      // B1/B2 research-mode constants (independent-resistance fit, wedge lookahead,
      // recency-weighted parallel fallback). Same rationale as the Step 6 block above -
      // capture.js never sets meta.research, so these don't change what it writes; hashed
      // here so future tuning is visible in configHash like every other detection constant.
      // ACT_WIDTH_MAX and the B5 distToRailPct gate live in radar.html's buildAction, not
      // channel-core.js - not exported from this module, so not hashed here.
      NEAR_FLAT_SLOPE_PCT: C.NEAR_FLAT_SLOPE_PCT, WEDGE_LOOKAHEAD: C.WEDGE_LOOKAHEAD,
      WEDGE_LOOKAHEAD_GRID: C.WEDGE_LOOKAHEAD_GRID, RES_RECENT_BARS: C.RES_RECENT_BARS,
      RES_RECENT_BARS_GRID: C.RES_RECENT_BARS_GRID
    })).digest('hex');
    const manifest = {
      schemaVersion: 1,
      detectorVersion: C.DETECTOR_VERSION,
      candleSchemaVersion: CANDLE_SCHEMA_VERSION,
      configHash: configHash,
      // Step 6 build-restage review (2026-09-22, BLOCKS 3 / R3): top-level flag, not folded
      // into configHash — capture.js itself never sets meta.research (R3: capture.js stays
      // flag-off), so this is always false here. Present so a manifest reader can tell "this
      // capture ran flag-off" without having to know what a match on configHash implies.
      researchMode: false,
      fetchCompletedAt: new Date().toISOString(),
      passes: {
        // grid "ok" is always true here — a genuinely failed grid pass (empty universe, no
        // coins pulled) already process.exit(1)s above, before this point is ever reached, so
        // reaching here means the grid pass itself succeeded even on a run where every date
        // was already captured (updated:false, ok:true — "nothing new was due", not a failure).
        grid: { ok: true, lastClosedCandle: newestGrid, updated: gridUpdatedThisRun },
        daily: { ok: dailyPassOk, lastClosedCandle: dailyLastClosedCandle, updated: dailyUpdatedThisRun },
        btcRegime: { ok: btcPassOk, lastClosedCandle: btcLastClosedCandle, updated: btcUpdatedThisRun }
      }
    };
    fs.writeFileSync(path.join(DATA_DIR, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('wrote data/capture-manifest.json');
  } catch (e) {
    console.error('CAPTURE MANIFEST WRITE FAILED (data above is unaffected and will still be committed):', e);
  }

  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
