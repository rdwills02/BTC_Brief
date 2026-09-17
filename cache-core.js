/* cache-core.js — incremental per-coin cache (Channel Radar upgrade #1a).
 * PURE — no fetch, no DOM. One JSON file per coin under data/cache/<cgId>.json.
 * Source-agnostic on purpose: today it holds CoinGecko's 4-day OHLC grid + daily
 * market_chart rows; milestone #2 (CCXT daily pass) appends the same candle shape
 * from exchange OHLCV without changing this module.
 *
 * File shape:
 * {
 *   cgId, symbol,
 *   marketChart: { "YYYY-MM-DD": {price, volume, marketCap}, ... },  // daily, append-only
 *   ohlc: [ {time, open, high, low, close, date}, ... ],             // append-only, deduped by date
 *   lastUpdated: ISO string
 * }
 *
 * Append-only by design: once a date is cached it is never overwritten by a later,
 * narrower pull. This is what makes the "backfill once, append after" pattern safe —
 * an incremental market_chart pull (last ~10 days) can never clobber older history,
 * and a duplicate OHLC candle for an already-cached grid date is simply skipped.
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
  return { cgId: cgId, symbol: symbol, marketChart: {}, ohlc: [], lastUpdated: null };
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

module.exports = {
  cachePath: cachePath, loadCache: loadCache, emptyCache: emptyCache,
  mergeMarketChart: mergeMarketChart, mergeOhlc: mergeOhlc, saveCache: saveCache,
  latestMarketChartDate: latestMarketChartDate
};
