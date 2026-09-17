/* capture.js — daily Channel Radar capture (runs in GitHub Actions, Node).
 *
 * Reuses the SAME shared logic as the live radar:
 *   - universe-core.js  (which coins qualify)
 *   - channel-core.js   (channel detection + scoring)
 *   - cache-core.js     (incremental per-coin cache — upgrade #1a, 2026-09-17)
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
 *
 * INCREMENTAL CACHE (upgrade #1a, 2026-09-17):
 *   data/cache/<cgId>.json holds each coin's full daily market_chart history and full OHLC
 *   grid history, append-only (see cache-core.js). The FIRST time a coin has no cache file,
 *   market_chart is pulled at its old full days=365. Every run after that, market_chart is
 *   pulled at a narrow days=10 window (MARKET_CHART_INCREMENTAL_DAYS) and merged onto the
 *   cache; volByDate/capByDate/priceByDate lookups are then served from the merged cache, so
 *   behavior is unchanged even though far less is downloaded per coin per day. This is the
 *   foundation upgrade #2 (CCXT daily pass) will build on — same cache file, same merge
 *   functions, a different fetch behind them.
 *   NOTE: the /ohlc pull itself stays a full 365-day pull every run — CoinGecko's OHLC
 *   endpoint has no "since" parameter, so it cannot be made incremental on this source.
 *   That redundancy is only removed by the source swap in upgrade #2, not by this cache.
 *   The OHLC series is still merged into the cache (append-only, deduped by date) so that
 *   swap has continuous history to build on and so the cache is a complete per-coin record,
 *   not just a bandwidth trick.
 */

const fs = require('fs');
const path = require('path');
const U = require('./universe-core.js');   // adjust path if capture.js not in repo root
const C = require('./channel-core.js');
const K = require('./cache-core.js');

const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_KEY = process.env.CG_KEY;                 // repo Secret
const DELAY_MS = 2200;                             // ~27 calls/min, safely under demo 30/min
const UNIVERSE_SIZE = 100;
const MARKETS_PER_PAGE = 200;
const BACKFILL_CANDLES = 4;    // how many recent grid-candles (each ~4 days) to backfill if missing
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
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
// cache for market_chart (see header). Returns the SAME shape as before the cache existed —
// rowForCandle() and everything downstream is unchanged.
async function pullCoin(coin) {
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
  K.saveCache(CACHE_DIR, cache);

  // Serve lookups from the MERGED cache (has full history even on an incremental-pull day).
  const volByDate = {}, capByDate = {}, priceByDate = {};
  for (const d in cache.marketChart) {
    const r = cache.marketChart[d];
    if (r.volume != null) volByDate[d] = r.volume;
    if (r.marketCap != null) capByDate[d] = r.marketCap;
    if (r.price != null) priceByDate[d] = r.price;
  }

  return { coin, candles, volByDate, capByDate, priceByDate };
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

  // Pull each coin's series ONCE.
  const pulls = [];
  for (const coin of universe) {
    const p = await pullCoin(coin);
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
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
