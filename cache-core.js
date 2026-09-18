/* cache-core.js — incremental per-coin cache (Channel Radar upgrade #1a).
 * PURE — no fetch, no DOM. One JSON file per coin under data/cache/<cgId>.json.
 * Source-agnostic on purpose: today it holds CoinGecko's 4-day OHLC grid + daily
 * market_chart rows.
 *
 * File shape:
 * {
 *   cgId, symbol,
 *   marketChart: { "YYYY-MM-DD": {price, volume, marketCap}, ... },  // daily
 *   ohlc: [ {time, open, high, low, close, date}, ... ],             // 4-day GRID candles (CoinGecko)
 *   ohlcDaily: [ {time, open, high, low, close, date}, ... ],        // exchange DAILY candles
 *          (upgrade #2, 2026-09-17: Kraken/Coinbase)
 *   lastUpdated: ISO string
 * }
 *
 * MERGE INVARIANT (restated, upgrade #7 amendment, 2026-09-19 — see Radar Future Updates.md #7
 * and the A1 amendment note): never drop a date the incoming pull doesn't cover. For any date
 * the incoming pull DOES cover, its value is authoritative and replaces whatever was cached —
 * dates outside the pull's coverage are left untouched.
 *
 * This replaces an earlier, narrower framing ("append-only; once a date is cached it's never
 * overwritten") that turned out to protect the wrong thing. Recency was never what needed
 * guarding — COVERAGE was. The original append-only rule was written to keep a narrow,
 * incremental pull from clobbering older history it never asked about, and it does that
 * correctly. But it also silently froze any date the pull DID re-cover with fresher data,
 * including the still-forming "today" bar — a coin's ohlcDaily.date === today stayed pinned at
 * that day's opening print for the rest of the day, up to +23% below the live price by the
 * day's later runs (measured 2026-09-18). A first attempted fix only re-opened the single
 * most-recent cached date to overwrites — that still has a rollover hole: at 00:00 UTC the
 * pull's newest date becomes tomorrow, so today's (now cooling, still-wrong) candle falls back
 * under append-only and its error becomes PERMANENT history. Measured: data/cache/stellar.json
 * holds 721 ohlcDaily candles, 720 of which match Kraken's true close exactly; the sole
 * exception is 2026-09-18, cached at that day's open, -5.5% off — the first candle ever cached
 * mid-formation, on the first rollover that would have tested (and failed) the recency-only
 * rule the same night.
 *
 * The date-coverage framing has no such hole and is simpler: Kraken's fetchKrakenDaily and
 * CoinGecko's /ohlc pull are BOTH full, authoritative re-pulls every run (721 candles / 365
 * days respectively) — every date they return is fresh truth, so every date they return should
 * win, self-healing ANY stale cached date they still cover, not just the newest one. Coinbase's
 * ~350-candle window and the incremental marketChart pull are narrower — for them, this same
 * rule means "refresh whatever you touched, never touch what you didn't," which is exactly the
 * safety the append-only rule was protecting in the first place.
 *
 * ohlc vs ohlcDaily (upgrade #2, 2026-09-17): these are DELIBERATELY SEPARATE arrays,
 * not one shared series. Both would otherwise dedupe by the SAME `date` key, and since
 * pullCoin() populates `ohlc` first every run, a 4-day CoinGecko candle would permanently
 * block that date's exchange daily candle from ever being merged in (mergeOhlc only adds
 * a date it hasn't seen). Two resolutions of the same coin must not interleave into one
 * series, so they get separate merge functions (mergeOhlc / mergeOhlcDailyCandles) and
 * separate arrays instead.
 */

const fs = require('fs');
const path = require('path');

function cachePath(cacheDir, cgId) {
  return path.join(cacheDir, cgId + '.json');
}

function loadCache(cacheDir, cgId) {
  const p = cachePath(cacheDir, cgId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function emptyCache(cgId, symbol) {
  return { cgId: cgId, symbol: symbol, marketChart: {}, ohlc: [], ohlcDaily: [], lastUpdated: null };
}

// rows: { "YYYY-MM-DD": {price?, volume?, marketCap?} }. Per the restated invariant (see file
// header): any date/field this pull covers is authoritative and overwrites the cached value;
// a date not present in `rows` at all is left completely untouched. Merged field-by-field
// (not a wholesale per-date replace) so a pull that only carries some of price/volume/marketCap
// for a date never blanks out a field it didn't touch.
//
// R1 (upgrade #7 work-order round 2, 2026-09-19): a FIELD PRESENT with value null/undefined is
// treated the same as a field that's absent — never assigned over a good cached value. This
// matters uniquely here: unlike mergeOhlc/mergeOhlcDailyCandles, which merge whole candle objects
// wholesale (no per-field assembly, so a partial candle isn't a real scenario), this function
// builds each date's row field-by-field from THREE separate CoinGecko series (prices/
// total_volumes/market_caps) that can each come back short. The old field-level Object.assign
// would happily overwrite a good cached volume with an incoming null if CoinGecko returned a
// partial row for that date — something the ORIGINAL append-only invariant could never do (it
// never touched an already-cached date at all). Keeping ONE invariant across all three merge
// functions is still correct (an inconsistent invariant is exactly what produced #7); this just
// makes that invariant null-safe for the one merge function assembling rows from parts.
function mergeMarketChart(cache, rows) {
  for (const date in rows) {
    const incoming = rows[date];
    const existing = cache.marketChart[date] || {};
    const merged = {};
    for (const k in existing) merged[k] = existing[k];
    for (const k in incoming) {
      if (incoming[k] !== null && incoming[k] !== undefined) merged[k] = incoming[k];
    }
    cache.marketChart[date] = merged;
  }
  return cache;
}

// Shared merge for both candle arrays (upgrade #7 fix, restated 2026-09-19 — see file header).
// Any date present in `candles` is authoritative and replaces the cached entry for that date,
// including a date the cache already had; a cached date NOT present in `candles` is left
// untouched. This self-heals a still-forming bar every run it's re-pulled (today's daily
// candle, the 4-day grid's open interval) AND survives the day rolling over, because the fix
// no longer depends on "which date is newest" — only on "did this pull return it."
function mergeCandlesInto(arr, candles) {
  if (!candles || !candles.length) return arr;
  const byDate = new Map(arr.map(function (c) { return [c.date, c]; }));
  for (const c of candles) {
    byDate.set(c.date, c);   // authoritative for every date this pull covers — new or refreshed
  }
  const merged = Array.from(byDate.values());
  merged.sort(function (a, b) { return a.time - b.time; });
  return merged;
}

// candles: [{time,open,high,low,close,date}, ...]. See mergeCandlesInto above.
function mergeOhlc(cache, candles) {
  cache.ohlc = mergeCandlesInto(cache.ohlc, candles);
  return cache;
}

// candles: [{time,open,high,low,close,date}, ...] from an EXCHANGE daily pull (upgrade #2).
// Same semantics as mergeOhlc, kept in the separate `ohlcDaily` array — see the file-shape
// note at the top of this module for why.
function mergeOhlcDailyCandles(cache, candles) {
  if (!cache.ohlcDaily) cache.ohlcDaily = [];
  cache.ohlcDaily = mergeCandlesInto(cache.ohlcDaily, candles);
  return cache;
}

function saveCache(cacheDir, cache) {
  fs.mkdirSync(cacheDir, { recursive: true });
  cache.lastUpdated = new Date().toISOString();
  fs.writeFileSync(cachePath(cacheDir, cache.cgId), JSON.stringify(cache));
}

// Latest cached market_chart date, or null if the cache is empty/missing/fresh.
function latestMarketChartDate(cache) {
  const dates = Object.keys(cache.marketChart);
  if (!dates.length) return null;
  dates.sort();
  return dates[dates.length - 1];
}

// Oldest cached ohlcDaily date, or null if empty/missing — used to decide whether a
// Coinbase-primary coin (max ~350 candles/call, no incremental "since") still needs a
// one-time top-up call to reach the ~365-day backfill target (see capture.js).
function oldestOhlcDailyDate(cache) {
  const arr = cache.ohlcDaily;
  if (!arr || !arr.length) return null;
  return arr.reduce(function (min, c) { return c.date < min ? c.date : min; }, arr[0].date);
}

module.exports = {
  cachePath: cachePath, loadCache: loadCache, emptyCache: emptyCache,
  mergeMarketChart: mergeMarketChart, mergeOhlc: mergeOhlc,
  mergeOhlcDailyCandles: mergeOhlcDailyCandles, saveCache: saveCache,
  latestMarketChartDate: latestMarketChartDate, oldestOhlcDailyDate: oldestOhlcDailyDate
};
