/* channel-history-gen.js — generate the historical-channel dataset for all universe coins.
 * Runs in Node (GitHub Action or local). Pulls 365d OHLC (4-day grid) per coin, runs
 * detect-all (channel-history.js), writes data/channels.json.
 * Reuses the SAME universe + fetch pattern as capture.js.
 */
const fs = require('fs');
const path = require('path');
const U = require('./universe-core.js');
const H = require('./channel-history.js');

const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_KEY = process.env.CG_KEY;
const DELAY_MS = 2200;
const UNIVERSE_SIZE = 100;
const MARKETS_PER_PAGE = 200;
const DATA_DIR = path.join(__dirname, 'data');

if (!CG_KEY) { console.error('FATAL: CG_KEY env not set'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cg(pathPart, retries = 3) {
  const sep = pathPart.includes('?') ? '&' : '?';
  const url = CG_BASE + pathPart + sep + 'x_cg_demo_api_key=' + CG_KEY;
  for (let a = 0; a <= retries; a++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(15000); continue; }
      if (!res.ok) { await sleep(2000); continue; }
      return await res.json();
    } catch (e) { await sleep(2000); }
  }
  return null;
}
function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }

async function buildUniverse() {
  const excluded = {};
  for (const slug of U.CATEGORY_EXCLUDE) {
    const d = await cg('/coins/markets?vs_currency=usd&category=' + slug + '&per_page=250&page=1&sparkline=false');
    if (Array.isArray(d)) for (const c of d) if (!excluded[c.id]) excluded[c.id] = slug;
    await sleep(DELAY_MS);
  }
  const data = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=' + MARKETS_PER_PAGE + '&page=1&sparkline=false');
  if (!Array.isArray(data)) return [];
  return data.filter(c => U.qualifiesForUniverse(c, excluded)).slice(0, UNIVERSE_SIZE);
}

async function pullCandles(coin) {
  const ohlc = await cg('/coins/' + coin.id + '/ohlc?vs_currency=usd&days=365');
  await sleep(DELAY_MS);
  if (!Array.isArray(ohlc) || ohlc.length < 20) return null;
  return ohlc.map(c => ({ time: Math.floor(c[0] / 1000), open: c[1], high: c[2], low: c[3], close: c[4], date: ymd(c[0]) }));
}

async function main() {
  const universe = await buildUniverse();
  console.log('universe:', universe.length, 'coins');
  if (!universe.length) { console.error('empty universe — aborting'); process.exit(1); }

  const allChannels = [];
  const perCoin = {};
  for (const coin of universe) {
    const candles = await pullCandles(coin);
    if (!candles) { perCoin[coin.symbol] = 0; continue; }
    const chans = H.detectAllChannels(candles, { symbol: (coin.symbol || '').toUpperCase(), cgId: coin.id });
    chans.forEach(ch => allChannels.push(ch));
    perCoin[(coin.symbol || '').toUpperCase()] = chans.length;
  }

  const out = {
    generated_at: new Date().toISOString(),
    window_days: 365,
    grid_interval_days: 4,
    universe_count: universe.length,
    channel_count: allChannels.length,
    channels: allChannels
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'channels.json'), JSON.stringify(out, null, 0));
  console.log('wrote data/channels.json —', allChannels.length, 'channels across', universe.length, 'coins');
  const dist = {}; Object.values(perCoin).forEach(n => dist[n] = (dist[n]||0)+1);
  console.log('channels-per-coin distribution:', JSON.stringify(dist));
}
main().catch(e => { console.error(e); process.exit(1); });
