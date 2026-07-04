/* capture.js — daily Channel Radar capture (runs in GitHub Actions, Node).
 *
 * Reuses the SAME shared logic as the live radar:
 *   - universe-core.js  (which coins qualify)
 *   - channel-core.js   (channel detection + scoring)
 * so captured data always matches what radar shows. Do NOT reimplement detection or
 * universe filtering here — require the cores.
 *
 * Each run:
 *   1. Build the live universe (markets + category-exclusion + shared filter).
 *   2. For every universe coin, pull 365d OHLC (/ohlc) and 365d daily price+mcap+volume
 *      (/market_chart), run detection.
 *   3. Write ONE dated file per captured day: /data/YYYY-MM/YYYY-MM-DD.json
 *      storing, per coin, that day's NEW raw bar + volume + market cap + detection output.
 *      (Full 365d series is pulled to compute detection but NOT re-stored — history
 *       accumulates as daily bars. Keeps the repo small.)
 *   4. BACKFILL: any missing recent day (last BACKFILL_LOOKBACK days) is reconstructed
 *      from the same 365d pull — sliced to end at that day (no look-ahead) — and marked
 *      backfilled:true. Detection FLAGS on backfilled days are reconstructed, so they are
 *      marked and should be treated as lower-confidence in lead-time analysis.
 */

const fs = require('fs');
const path = require('path');
const U = require('./universe-core.js');   // adjust path if capture.js not in repo root
const C = require('./channel-core.js');

const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_KEY = process.env.CG_KEY;                 // repo Secret
const DELAY_MS = 2200;                             // ~27 calls/min, safely under demo 30/min
const UNIVERSE_SIZE = 100;
const MARKETS_PER_PAGE = 200;
const BACKFILL_LOOKBACK = 14;                       // days back to check for gaps
const DATA_DIR = path.join(__dirname, 'data');

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

// Pull a coin's 365d OHLC candles + daily price/mcap/volume series.
async function pullCoin(coin) {
  const ohlcRaw = await cg('/coins/' + coin.id + '/ohlc?vs_currency=usd&days=365');
  await sleep(DELAY_MS);
  const chart = await cg('/coins/' + coin.id + '/market_chart?vs_currency=usd&days=365&interval=daily');
  await sleep(DELAY_MS);
  if (!Array.isArray(ohlcRaw) || ohlcRaw.length < 30) return null;

  const candles = ohlcRaw.map(c => ({ time: Math.floor(c[0] / 1000), open: c[1], high: c[2], low: c[3], close: c[4], date: ymd(c[0]) }));
  // index market_chart series by date
  const volByDate = {}, capByDate = {}, priceByDate = {};
  if (chart && chart.total_volumes) for (const [ms, v] of chart.total_volumes) volByDate[ymd(ms)] = v;
  if (chart && chart.market_caps)   for (const [ms, m] of chart.market_caps)   capByDate[ymd(ms)] = m;
  if (chart && chart.prices)        for (const [ms, p] of chart.prices)        priceByDate[ymd(ms)] = p;

  return { coin, candles, volByDate, capByDate, priceByDate };
}

// Build one coin's row for a given target date D (from already-pulled series).
// Detection runs on candles UP TO AND INCLUDING D (no look-ahead).
function rowForDate(pulled, D) {
  const { coin, candles, volByDate, capByDate, priceByDate } = pulled;
  const idx = candles.findIndex(c => c.date === D);
  if (idx < 0) return null;                         // no candle for D (coin too young / gap)
  const upto = candles.slice(0, idx + 1);
  const bar = candles[idx];
  const det = C.detectChannel(upto);               // shared detection; null if no channel
  return {
    cgId: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    rank: coin.market_cap_rank,
    date: D,
    ohlc: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
    volume24h: volByDate[D] != null ? volByDate[D] : null,
    marketCap: capByDate[D] != null ? capByDate[D] : null,
    price: priceByDate[D] != null ? priceByDate[D] : bar.close,
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

function targetDates() {
  // today (UTC) + any missing days within lookback window
  const out = [];
  const today = new Date();
  for (let i = 0; i < BACKFILL_LOOKBACK; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  // today always (re)written; older ones only if missing
  const todayStr = today.toISOString().slice(0, 10);
  return out.filter(D => D === todayStr || !dayFileExists(D));
}

async function main() {
  const dates = targetDates();
  const todayStr = new Date().toISOString().slice(0, 10);
  console.log('capturing dates:', dates.join(', '));

  const universe = await buildUniverse();
  console.log('universe:', universe.length, 'coins');
  if (!universe.length) { console.error('empty universe — aborting, not writing'); process.exit(1); }

  // Pull each coin's series ONCE; reuse for today + all backfill dates.
  const pulls = [];
  for (const coin of universe) {
    const p = await pullCoin(coin);
    if (p) pulls.push(p);
  }
  console.log('pulled series for', pulls.length, 'coins');

  for (const D of dates) {
    const coins = [];
    for (const p of pulls) {
      const row = rowForDate(p, D);
      if (row) coins.push(row);
    }
    if (!coins.length) { console.log('no data for', D, '- skipping'); continue; }
    writeDayFile(D, {
      date: D,
      captured_at: new Date().toISOString(),
      backfilled: D !== todayStr,
      universe_count: pulls.length,
      coins
    });
  }
  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
