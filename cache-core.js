/* cache-core.js — incremental per-coin cache (Channel Radar upgrade #1a).
 * PURE — no fetch, no DOM. One JSON file per coin under data/cache/<cgId>.json.
 * Source-agnostic on purpose: today it holds CoinGecko's 4-day OHLC grid + daily
 * market_chart rows.
 *
 * File shape:
 * {
 *   cgId, symbol,
 *   marketChart: { "YYYY-MM-DD": {price, volume, marketCap}, ... },  // daily, append-only
 *   ohlc: [ {time, open, high, low, close, date}, ... ],             // 4-day GRID candles
 *          (CoinGecko), append-only, deduped by date
 *   ohlcDaily: [ {time, open, high, low, close, date}, ... ],        // exchange DAILY candles
 *          (upgrade #2, 2026-09-17: Kraken/Coinbase), append-only, deduped by date
 *   lastUpdated: ISO string
 * }
 *
 * Append-only by design: once a date is cached it is never overwritten by a later,
 * narrower pull. This is what makes the "backfill once, append after" pattern safe —
 * an incremental market_chart pull (last ~10 days) can never clobber older history,
 * and a duplicate OHLC candle for an already-cached grid date is simply skipped.
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

// rows: { "YYYY-MM-DD": {price?, volume?, marketCap?} }. Existing dates are left untouched.
function mergeMarketChart(cache, rows) {
  for (const date in rows) {
    if (!(date in cache.marketChart)) cache.marketChart[date] = rows[date];
  }
  return cache;
}

// candles: [{time,open,high,low,close,date}, ...]. Deduped by date; existing dates untouched.
function mergeOhlc(cache, candles) {
  const seen = new Set(cache.ohlc.map(function (c) { return c.date; }));
  for (const c of candles) {
    if (!seen.has(c.date)) { cache.ohlc.push(c); seen.add(c.date); }
  }
  cache.ohlc.sort(function (a, b) { return a.time - b.time; });
  return cache;
}

// candles: [{time,open,high,low,close,date}, ...] from an EXCHANGE daily pull (upgrade #2).
// Same dedup-by-date/sort-by-time semantics as mergeOhlc, but kept in the separate
// `ohlcDaily` array — see the file-shape note at the top of this module for why.
function mergeOhlcDailyCandles(cache, candles) {
  if (!cache.ohlcDaily) cache.ohlcDaily = [];
  const seen = new Set(cache.ohlcDaily.map(function (c) { return c.date; }));
  for (const c of candles) {
    if (!seen.has(c.date)) { cache.ohlcDaily.push(c); seen.add(c.date); }
  }
  cache.ohlcDaily.sort(function (a, b) { return a.time - b.time; });
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
