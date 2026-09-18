/* exchange-map.js — CoinGecko id -> exchange ticker mapping (Channel Radar upgrade #2).
 * PURE-ish (one dependency: fetch) — no other project module required, mirrors the pattern
 * already proven live in radar.html's tvLink()/fetchTVFallbackSets() and in
 * radar_tools/exchange_coverage.py (the offline/Python validation tool; keep the ALIAS table
 * in sync between the two if a new symbol mismatch surfaces).
 *
 * Built FRESH every capture run — 2 calls total (Kraken AssetPairs, Coinbase products), not
 * per-coin — because the universe rotates and this is cheap either way.
 *
 * Keyed by cgId, not symbol: cgId is the persistent join key the rest of the pipeline already
 * uses (data/cache/<cgId>.json), so the map has to speak that language even though the match
 * itself is done by symbol against the exchanges' own ticker lists.
 *
 * Preference when a coin is on both: KRAKEN, then COINBASE — mirrors the fallback order
 * radar.html's own tvLink() already uses, and Kraken measurably carries more of the long tail
 * (72 both / 15 Kraken-only / 1 Coinbase-only, per exchange_coverage.py's 2026-09-17 run).
 *
 * Collision guard: matching is by symbol, so if two coins IN THE SAME UNIVERSE share a symbol,
 * naive matching would silently attribute one exchange ticker's data to the wrong coin. Any
 * such collision is logged and BOTH coins are left unmapped (no entry) rather than guessing —
 * callers fall back to CoinGecko-4d detection for anything with no map entry. Verified
 * 2026-09-17: the live 97-coin universe has zero symbol collisions today, but the universe
 * rotates, so this guard is a real safety net, not defensive boilerplate.
 */

const ALIAS = { BTC: ['XBT'], DOGE: ['XDG'], LUNA: ['LUNA2'] };
const QUOTES = new Set(['USD', 'USDT', 'USDC']);

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('exchange-map: fetch failed ' + res.status + ' ' + url);
  return res.json();
}

async function krakenBases() {
  const d = await fetchJson('https://api.kraken.com/0/public/AssetPairs');
  const bases = new Set();
  const pairs = (d && d.result) || {};
  for (const k in pairs) {
    const ws = pairs[k].wsname;
    if (ws && ws.indexOf('/') >= 0) {
      const parts = ws.split('/');
      const base = parts[0], quote = parts[1];
      if (QUOTES.has(quote)) bases.add(base.toUpperCase());
    }
  }
  return bases;
}

async function coinbaseBases() {
  const d = await fetchJson('https://api.exchange.coinbase.com/products', { headers: { 'User-Agent': 'radar-capture/1.0' } });
  const bases = new Set();
  for (const p of (Array.isArray(d) ? d : [])) {
    if (QUOTES.has(p.quote_currency) && p.status === 'online') bases.add((p.base_currency || '').toUpperCase());
  }
  return bases;
}

function hasSym(set, sym) {
  return set.has(sym) || (ALIAS[sym] || []).some(function (a) { return set.has(a); });
}

// coins: [{id, symbol}] — the live universe (coin.id = cgId).
// Returns { cgId: {exchange:'kraken'|'coinbase', ticker, quote:'USD'} } for matched coins.
// A coin absent from the returned map has no exchange mapping — caller falls back to
// CoinGecko-4d detection only for that coin (see capture.js's daily pass).
async function buildExchangeMap(coins, fetchers) {
  fetchers = fetchers || { krakenBases, coinbaseBases };
  const results = await Promise.all([fetchers.krakenBases(), fetchers.coinbaseBases()]);
  const kr = results[0], cb = results[1];

  const symCount = {};
  for (const c of coins) {
    const sym = (c.symbol || '').toUpperCase();
    symCount[sym] = (symCount[sym] || 0) + 1;
  }

  const map = {};
  const collisions = [];
  for (const c of coins) {
    const sym = (c.symbol || '').toUpperCase();
    if (symCount[sym] > 1) { collisions.push(sym); continue; }
    if (hasSym(kr, sym)) map[c.id] = { exchange: 'kraken', ticker: sym, quote: 'USD' };
    else if (hasSym(cb, sym)) map[c.id] = { exchange: 'coinbase', ticker: sym, quote: 'USD' };
    // else: no entry -> CoinGecko-4d fallback, handled by the caller.
  }
  if (collisions.length) {
    const uniq = Array.from(new Set(collisions));
    console.warn('exchange-map: symbol collision(s) in universe, forced to CoinGecko fallback:', uniq.join(', '));
  }
  return map;
}

module.exports = { buildExchangeMap, krakenBases, coinbaseBases, hasSym, ALIAS, QUOTES };
