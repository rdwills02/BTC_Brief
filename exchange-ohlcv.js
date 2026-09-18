/* exchange-ohlcv.js — daily OHLCV pull from Kraken/Coinbase public REST (Channel Radar
 * upgrade #2). DELIBERATELY NOT CCXT — see the M2 build report for why. Both endpoints are
 * keyless, unauthenticated, and their exact shapes/limits were live-verified 2026-09-17 (via
 * the in-app browser, since this session's own shells can't reach these hosts directly):
 *   Kraken   /0/public/OHLC?pair=<TICKER>USD&interval=1440    -> 721 candles/call, no `since`
 *            needed — covers a 365-day backfill in ONE call, every run, for every Kraken coin.
 *   Coinbase /products/<TICKER>-USD/candles?granularity=86400 -> 350 candles/call with NO
 *            explicit range; an EXPLICIT start/end range hard-caps at 300 and 400s past it
 *            ("Count of aggregations requested exceeds 300"). 350 < 365, so a Coinbase-primary
 *            coin needs a one-time top-up call (explicit range) to reach the full 365-day
 *            backfill target — see fetchCoinbaseDaily's `backfillGapTo` option.
 * Both raw responses are normalized to cache-core.js's candle shape ({time,open,high,low,
 * close,date}) and returned sorted ascending by time — their raw wire ordering is never
 * assumed.
 */

const KRAKEN_BASE = 'https://api.kraken.com/0/public';
const COINBASE_BASE = 'https://api.exchange.coinbase.com';

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('exchange-ohlcv: fetch failed ' + res.status + ' ' + url);
  return res.json();
}

// Kraken candle: [time(s), open, high, low, close, vwap, volume, count] — OHLC as strings.
async function fetchKrakenDaily(ticker) {
  const pair = ticker + 'USD';
  const d = await fetchJson(KRAKEN_BASE + '/OHLC?pair=' + pair + '&interval=1440');
  if (d.error && d.error.length) throw new Error('kraken OHLC error: ' + d.error.join(', '));
  const key = Object.keys(d.result || {}).find(function (k) { return k !== 'last'; });
  if (!key) return [];
  const rows = d.result[key];
  return rows.map(function (r) {
    const ms = r[0] * 1000;
    return { time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], date: ymd(ms) };
  }).sort(function (a, b) { return a.time - b.time; });
}

// Coinbase candle: [time(s), low, high, open, close, volume].
function normalizeCoinbase(rows) {
  return rows.map(function (r) {
    const ms = r[0] * 1000;
    return { time: r[0], open: +r[3], high: +r[2], low: +r[1], close: +r[4], date: ymd(ms) };
  });
}

// opts.backfillGapTo: a 'YYYY-MM-DD' the caller wants history to reach back to (first-ever
// pull only — see capture.js). If the unranged call's oldest candle doesn't reach that far,
// ONE additional explicit-range call fills the gap (Coinbase caps a ranged call at 300).
async function fetchCoinbaseDaily(ticker, opts) {
  opts = opts || {};
  const product = ticker + '-USD';
  const unranged = await fetchJson(COINBASE_BASE + '/products/' + product + '/candles?granularity=86400');
  let candles = normalizeCoinbase(Array.isArray(unranged) ? unranged : []);
  if (!candles.length) return [];
  candles.sort(function (a, b) { return a.time - b.time; });

  if (opts.backfillGapTo && candles[0].date > opts.backfillGapTo) {
    const end = new Date(candles[0].time * 1000);
    const start = new Date(end.getTime() - 290 * 86400000); // stay under Coinbase's 300 cap
    const ranged = await fetchJson(
      COINBASE_BASE + '/products/' + product + '/candles?granularity=86400&start=' +
      start.toISOString() + '&end=' + end.toISOString()
    );
    candles = candles.concat(normalizeCoinbase(Array.isArray(ranged) ? ranged : []));
  }
  const seen = new Set();
  candles = candles.filter(function (c) {
    if (seen.has(c.date)) return false;
    seen.add(c.date); return true;
  });
  candles.sort(function (a, b) { return a.time - b.time; });
  return candles;
}

module.exports = { fetchKrakenDaily, fetchCoinbaseDaily };
