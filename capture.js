/* capture.js — daily Channel Radar capture (runs in GitHub Actions, Node).
 *
 * Reuses the SAME shared logic as the live radar:
 *   - universe-core.js  (which coins qualify)
 *   - channel-core.js   (channel detection + scoring)
 *   - cache-core.js     (incremental per-coin cache — upgrade #1a, 2026-09-17)
 *   - exchange-map.js   (CoinGecko id -> exchange ticker — upgrade #2, 2026-09-17)
 *   - exchange-ohlcv.js (Kraken/Coinbase daily OHLCV pull — upgrade #2, 2026-09-17)
 * so captured data always matches what radar shows. Do NOT reimplement detection or
 * universe filtering here — require the cores.
 *
 * Each run:
 *   1. Build the live universe (markets + category-exclusion + shared filter).
 *   2. For every universe coin, pull 365d OHLC (/ohlc, always full — CoinGecko has no
 *      incremental OHLC query) and daily price+mcap+volume (/market_chart, INCREMENTAL
 *      after the first run — see pullCoin), run detection.
 *   3. Write ONE file per OHLC GRID CANDLE: /data/YYYY-MM/YYYY-MM-DD.json.
 *      CoinGecko's /ohlc at days=365 returns candles every ~4 days — this is the SAME
 *      resolution the live radar detects on, so capture matches the system's native basis.
 *      Each file stores, per coin, that candle's raw bar + SUMMED volume over the candle's
 *      ~4-day span + market cap + detection output. (Full series pulled to compute detection
 *      but not re-stored here; that history now lives in data/cache/ instead — see below.)
 *   4. BACKFILL: the newest BACKFILL_CANDLES grid dates are written if their file is missing,
 *      reconstructed from the same pull (sliced to end at that candle, no look-ahead). Only the
 *      newest CLOSED candle is "live"; older written candles are marked backfilled:true and
 *      their detection FLAGS should be treated as lower-confidence in lead-time analysis.
 *      NOTE: the newest closed candle may be up to ~3 days before the run date (4-day grid).
 *   5. DAILY-BASIS STREAM (upgrade #2, 2026-09-17), ALONGSIDE the 4-day grid, not replacing
 *      it: /data/daily/YYYY-MM-DD.json, written EVERY run (today's date, not a grid date).
 *      Same detectChannel() as step 3, fed exchange daily candles (Kraken preferred, then
 *      Coinbase, then CoinGecko-4d fallback for uncovered coins) instead of the 4-day grid.
 *      This is a SEPARATE file, not a field added to the step-3 files, because (a) the step-3
 *      files only get written when a new grid candle closes (~every 4 days) — cramming daily
 *      detection into them would leave it stale 3 of every 4 days — and (b)
 *      radar_tools/radar_postmortem.py globs every *.json under a --data root; a shared file
 *      would silently corrupt its timeline. Written UNFILTERED by score, same principle as
 *      upgrade #1c's candidates(): a flagged coin here is #3/#4 training data, and any score
 *      floor (currently 60) is a radar.html DISPLAY default only, never a write-time filter.
 *
 * INCREMENTAL CACHE (upgrade #1a, 2026-09-17):
 *   data/cache/<cgId>.json holds each coin's full daily market_chart history and full OHLC
 *   grid history, append-only (see cache-core.js). The FIRST time a coin has no cache file,
 *   market_chart is pulled at its old full days=365. Every run after that, market_chart is
 *   pulled at a narrow days=10 window (MARKET_CHART_INCREMENTAL_DAYS) and merged onto the
 *   cache; volByDate/capByDate/priceByDate lookups are then served from the merged cache, so
 *   behavior is unchanged even though far less is downloaded per coin per day.
 *   NOTE: the /ohlc pull itself stays a full 365-day pull every run — CoinGecko's OHLC
 *   endpoint has no "since" parameter, so it cannot be made incremental on this source. THIS
 *   IS STILL TRUE AFTER UPGRADE #2: the daily pass runs ALONGSIDE the 4-day grid (see step 5
 *   above), so it adds exchange calls on top of the unchanged CoinGecko call volume — it does
 *   NOT reduce the ~210 calls/day CoinGecko quota. #2's value is recall (catching moves the
 *   4-day grid misses), not quota reduction; nothing in this pipeline reduces the CoinGecko
 *   quota. Same cache file, cache.ohlcDaily now carries the exchange daily series alongside
 *   cache.ohlc's 4-day grid series (kept as two separate arrays — see cache-core.js's header
 *   for why they can't share one).
 *
 * EXCHANGE OHLCV (upgrade #2, 2026-09-17): deliberately RAW FETCH against Kraken/Coinbase
 * public REST, NOT the CCXT library the original backlog wording assumed. Both endpoints'
 * exact shapes and per-call candle limits were live-verified 2026-09-17 (see exchange-ohlcv.js
 * header) and are simple enough to hand-roll with the SAME zero-dependency style already used
 * everywhere else in this file — no new npm dependency, no capture.yml edit, no workflow-scope
 * blocker to work around. Adds ~2 calls/run (building the exchange map) + ~1 call/coin/run for
 * every coin with a Kraken or Coinbase mapping (~88 of 97 coins today) — both keyless,
 * unauthenticated, no documented rate limit that this volume approaches.
 */

const fs = require('fs');
const path = require('path');
const U = require('./universe-core.js');   // adjust path if capture.js not in repo root
const C = require('./channel-core.js');
const K = require('./cache-core.js');
const X = require('./exchange-map.js');    // upgrade #2
const EX = require('./exchange-ohlcv.js'); // upgrade #2

const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_KEY = process.env.CG_KEY;                 // repo Secret
const DELAY_MS = 2200;                             // ~27 calls/min, safely under demo 30/min
const EXCHANGE_DELAY_MS = 300;                     // polite pacing for Kraken/Coinbase (keyless, no documented limit near this volume)
const UNIVERSE_SIZE = 100;
const MARKETS_PER_PAGE = 200;
const BACKFILL_CANDLES = 4;    // how many recent grid-candles (each ~4 days) to backfill if missing
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const DAILY_DIR = path.join(DATA_DIR, 'daily');    // upgrade #2 — parallel daily-basis stream
const MARKET_CHART_BACKFILL_DAYS = 365;    // first-ever pull for a coin (no cache yet)
const MARKET_CHART_INCREMENTAL_DAYS = 10;  // subsequent pulls once cached — 10d overlap for safety

// Display categories (context tags shown on radar/report). Mirrors radar's DISPLAY_CATEGORIES.
// Each is a CoinGecko category slug + the label to store. 7 extra calls/run (negligible).
const DISPLAY_CATEGORIES = [
  { slug: 'artificial-intelligence', label: 'AI' },
  { slug: 'decentralized-finance-defi', label: 'DeFi' },
  { slug: 'layer-1', label: 'Layer 1' },
  { slug: 'layer-2', label: 'Layer 2' },
  { slug: 'oracle', label: 'Oracle' },
  { slug: 'meme-token', label: 'Meme' },
  { slug: 'privacy-coins', label: 'Privacy Coin' }
];

if (!CG_KEY) { console.error('FATAL: CG_KEY env not set'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cg(pathPart, retries = 3) {
  const sep = pathPart.includes('?') ? '&' : '?';
  const url = CG_BASE + pathPart + sep + 'x_cg_demo_api_key=' + CG_KEY;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(15000); continue; }
      if (!res.ok) { await sleep(2000); continue; }
      return await res.json();
    } catch (e) { await sleep(2000); }
  }
  return null;
}

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }   // UTC YYYY-MM-DD

// Build the live universe using the SHARED filter (no diag needed here).
async function buildUniverse() {
  const excluded = {};
  for (const slug of U.CATEGORY_EXCLUDE) {
    const d = await cg('/coins/markets?vs_currency=usd&category=' + slug + '&per_page=250&page=1&sparkline=false');
    if (Array.isArray(d)) for (const c of d) if (!excluded[c.id]) excluded[c.id] = slug;
    await sleep(DELAY_MS);
  }
  const data = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=' + MARKETS_PER_PAGE + '&page=1&sparkline=false&price_change_percentage=24h');
  if (!Array.isArray(data)) return [];
  return data.filter(c => U.qualifiesForUniverse(c, excluded)).slice(0, UNIVERSE_SIZE);
}

// Fetch display-category membership -> { coinId: 'Label' }. 7 calls. Context tags only.
async function fetchCategoryLabels() {
  const labels = {};
  for (const dc of DISPLAY_CATEGORIES) {
    const d = await cg('/coins/markets?vs_currency=usd&category=' + dc.slug + '&per_page=250&page=1&sparkline=false');
    if (Array.isArray(d)) for (const c of d) if (!labels[c.id]) labels[c.id] = dc.label;
    await sleep(DELAY_MS);
  }
  return labels;
}

// Pull a coin's 365d OHLC candles + daily price/mcap/volume series, using the incremental
// cache for market_chart (see header). Also pulls the exchange daily series (upgrade #2) if
// `mapping` is given, merging it into the SAME per-coin cache file (cache.ohlcDaily).
// Returns the SAME 4-day-pass shape as before, plus dailySource/dailyCandles for rowForDaily().
async function pullCoin(coin, mapping) {
  const ohlcRaw = await cg('/coins/' + coin.id + '/ohlc?vs_currency=usd&days=365');
  await sleep(DELAY_MS);

  let cache = K.loadCache(CACHE_DIR, coin.id) || K.emptyCache(coin.id, coin.symbol);
  const hasHistory = K.latestMarketChartDate(cache) !== null;
  const chartDays = hasHistory ? MARKET_CHART_INCREMENTAL_DAYS : MARKET_CHART_BACKFILL_DAYS;
  const chart = await cg('/coins/' + coin.id + '/market_chart?vs_currency=usd&days=' + chartDays + '&interval=daily');
  await sleep(DELAY_MS);
  if (!Array.isArray(ohlcRaw) || ohlcRaw.length < 30) return null;

  const candles = ohlcRaw.map(c => ({ time: Math.floor(c[0] / 1000), open: c[1], high: c[2], low: c[3], close: c[4], date: ymd(c[0]) }));

  // This pull's daily rows, by date, merged onto the cache (append-only — never overwrites).
  const newRows = {};
  if (chart && chart.prices) for (const [ms, p] of chart.prices) {
    const d = ymd(ms); (newRows[d] || (newRows[d] = {})).price = p;
  }
  if (chart && chart.total_volumes) for (const [ms, v] of chart.total_volumes) {
    const d = ymd(ms); (newRows[d] || (newRows[d] = {})).volume = v;
  }
  if (chart && chart.market_caps) for (const [ms, m] of chart.market_caps) {
    const d = ymd(ms); (newRows[d] || (newRows[d] = {})).marketCap = m;
  }
  K.mergeMarketChart(cache, newRows);
  K.mergeOhlc(cache, candles);

  // --- Exchange daily pull (upgrade #2, 2026-09-17). Best-effort: a failure here never
  // aborts the coin's 4-day pass, it just falls back to CoinGecko-4d for the daily stream. ---
  let dailySource = 'coingecko-4d-fallback';
  if (mapping) {
    try {
      let dailyCandles;
      if (mapping.exchange === 'kraken') {
        dailyCandles = await EX.fetchKrakenDaily(mapping.ticker);   // one call covers full backfill, every run
      } else {
        const oldestCached = K.oldestOhlcDailyDate(cache);
        const backfillGapTo = oldestCached === null
          ? new Date(Date.now() - MARKET_CHART_BACKFILL_DAYS * 86400000).toISOString().slice(0, 10)
          : null;   // only the first-ever pull for a Coinbase-primary coin needs the gap-fill call
        dailyCandles = await EX.fetchCoinbaseDaily(mapping.ticker, backfillGapTo ? { backfillGapTo } : {});
      }
      K.mergeOhlcDailyCandles(cache, dailyCandles);
      dailySource = mapping.exchange;
    } catch (e) {
      console.warn('daily pull failed for', coin.id, '(' + mapping.exchange + '):', e.message);
      dailySource = mapping.exchange + '-failed';   // keeps whatever's already cached, if anything
    }
    await sleep(EXCHANGE_DELAY_MS);
  }

  K.saveCache(CACHE_DIR, cache);   // one save, after both the 4-day and daily merges

  // Serve lookups from the MERGED cache (has full history even on an incremental-pull day).
  const volByDate = {}, capByDate = {}, priceByDate = {};
  for (const d in cache.marketChart) {
    const r = cache.marketChart[d];
    if (r.volume != null) volByDate[d] = r.volume;
    if (r.marketCap != null) capByDate[d] = r.marketCap;
    if (r.price != null) priceByDate[d] = r.price;
  }

  return { coin, candles, volByDate, capByDate, priceByDate, dailySource, dailyCandles: cache.ohlcDaily };
}

// Build one coin's row for the candle at index `idx` (from already-pulled series).
// OHLC is every ~4 days (CoinGecko's 365d granularity) — this is the SAME resolution the
// live radar detects on, so capture matches the system's native basis.
// Detection runs on candles UP TO AND INCLUDING idx (no look-ahead).
// Volume is SUMMED over the candle's span (from the day after the previous candle through
// this candle's date) so it represents the whole ~4-day bar, not a single day.
function rowForCandle(pulled, idx, catLabels) {
  const { coin, candles, volByDate, capByDate, priceByDate } = pulled;
  if (idx < 0 || idx >= candles.length) return null;
  const bar = candles[idx];
  const D = bar.date;
  const upto = candles.slice(0, idx + 1);
  const det = C.detectChannel(upto);               // shared detection; null if no channel

  // Sum daily volumes across this candle's span (exclusive of the prior candle's date).
  const prevDate = idx > 0 ? candles[idx - 1].date : null;
  let volSum = 0, volHave = false;
  for (const d in volByDate) {
    if (d <= D && (prevDate === null || d > prevDate)) { volSum += volByDate[d]; volHave = true; }
  }

  return {
    cgId: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    rank: coin.market_cap_rank,
    date: D,
    ohlc: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
    volumeSpan: volHave ? volSum : null,            // summed volume over the ~4-day candle span
    marketCap: capByDate[D] != null ? capByDate[D] : null,
    price: priceByDate[D] != null ? priceByDate[D] : bar.close,
    change24h: coin.price_change_percentage_24h != null ? coin.price_change_percentage_24h : null, // point-in-time (capture date)
    volume24h: coin.total_volume != null ? coin.total_volume : null,   // live 24h volume at capture time
    category: (catLabels && catLabels[coin.id]) || null,   // display context tag (or null)
    detection: det   // full detectChannel output, or null (kept even when null = control group)
  };
}

// Build one coin's row for the DAILY stream (upgrade #2). Unlike rowForCandle(), there's no
// grid-index slicing — this runs once per calendar day on whatever daily history is cached,
// so it always uses the full series. Written for EVERY coin, EVERY run, regardless of score —
// see the header note on why this is unfiltered (same principle as upgrade #1c's candidates()).
function rowForDaily(pulled, catLabels) {
  const { coin, dailySource, dailyCandles } = pulled;
  const base = {
    cgId: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    rank: coin.market_cap_rank,
    price: coin.current_price != null ? coin.current_price : null,
    change24h: coin.price_change_percentage_24h != null ? coin.price_change_percentage_24h : null,
    volume24h: coin.total_volume != null ? coin.total_volume : null,
    marketCap: coin.market_cap != null ? coin.market_cap : null,
    category: (catLabels && catLabels[coin.id]) || null,
    dailySource: dailySource   // 'kraken' | 'coinbase' | 'coingecko-4d-fallback' | '<exchange>-failed'
  };
  if (!dailyCandles || dailyCandles.length < 30) {
    return Object.assign(base, { detectionDaily: null });
  }
  const det = C.detectChannel(dailyCandles);   // SAME shared detection as the 4-day pass —
                                                // no separate scoring logic, no write-time
                                                // score filter (see header).
  return Object.assign(base, { detectionDaily: det });
}

function dayFilePath(D) {
  const month = D.slice(0, 7);
  return path.join(DATA_DIR, month, D + '.json');
}
function dayFileExists(D) { return fs.existsSync(dayFilePath(D)); }
function writeDayFile(D, obj) {
  const p = dayFilePath(D);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 0));
  console.log('wrote', p, '(' + obj.coins.length + ' coins, backfilled=' + obj.backfilled + ')');
}

async function main() {
  const universe = await buildUniverse();
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

  // Pull each coin's series ONCE.
  const pulls = [];
  for (const coin of universe) {
    const p = await pullCoin(coin, exMap[coin.id]);
    if (p) pulls.push(p);
  }
  console.log('pulled series for', pulls.length, 'coins');
  if (!pulls.length) { console.error('no coin data pulled — aborting'); process.exit(1); }

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
    if (dayFileExists(D)) { console.log(D, 'already captured - skipping'); continue; }
    const coins = [];
    for (const p of pulls) {
      const idx = p.candles.findIndex(c => c.date === D);
      if (idx < 0) continue;                                   // coin has no candle on this grid date
      const row = rowForCandle(p, idx, catLabels);
      if (row) coins.push(row);
    }
    if (!coins.length) { console.log('no coin candles on', D, '- skipping'); continue; }
    const payload = {
      date: D,
      captured_at: new Date().toISOString(),
      grid_interval_days: 4,
      backfilled: D !== newestGrid,   // only the newest closed candle is "live"; older = backfilled
      universe_count: pulls.length,
      coins
    };
    writeDayFile(D, payload);
    if (D === newestGrid) newestPayload = payload;
  }

  // Maintain data/latest.json -> the newest capture, so radar can load it without dir listing.
  // Always point at the newest grid date; rebuild from its file if we skipped writing it.
  if (!newestPayload && dayFileExists(newestGrid)) {
    try { newestPayload = JSON.parse(fs.readFileSync(dayFilePath(newestGrid), 'utf8')); } catch (e) {}
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
    const dailyCoins = pulls.map(p => {
      try {
        return rowForDaily(p, catLabels);
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
    const dailyPayload = {
      date: todayDate,
      captured_at: new Date().toISOString(),
      universe_count: dailyCoins.length,
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
  } catch (e) {
    console.error('DAILY-BASIS STREAM FAILED this run (4-day capture above is unaffected and will still be committed):', e);
  }

  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
