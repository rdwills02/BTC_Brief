/* universe-core.js — shared UNIVERSE SELECTION logic (live/operational universe).
 * Consumed by radar.html (browser) AND the capture Action (Node) — the two consumers
 * that want radar's live tradeable universe. The BACKTEST does NOT use this (its
 * historical universe is deliberately different: positive category inclusion, no volume
 * floor, data-sufficiency gate).
 *
 * PURE selection only: no fetch, no DOM. Each environment does its own CoinGecko fetching
 * and passes results in. Extracted VERBATIM from the live radar.html (2026-07-04).
 *
 * `counts` is OPTIONAL. radar passes its diag object so the Scan Details bar tallies
 * category/volume exclusions; the Action omits it. The yes/no result is identical either way.
 */

var STABLES = ['usdt','usdc','busd','dai','tusd','fdusd','usdp','frax','lusd','usdd','eurs','usdn','usdg','usdf','bfusd','pyusd','usde','usds','ausd','eurc','paxg','xaut','wbtc','gho','jst','rai','lunc','ylds','sta','stable'];

// Category slugs excluded via CoinGecko category calls (2-call approach). exchange-based-tokens
// and real-world-assets-rwa were removed 2026-07-03 (too broad — caught legit alts). Noise is
// handled by EXCLUDE_SYMBOLS instead. Do NOT reintroduce broad category exclusion.
var CATEGORY_EXCLUDE = ['stablecoins','wrapped-tokens'];

// Manually-vetted noise symbols from the 2026-07-03 coin audit (not real/tradeable, or
// single-exchange tokens). Matched after zero-width stripping. Append as new noise is confirmed.
var EXCLUDE_SYMBOLS = ['a7a5','prime','fig','figr_heloc','leo','ren','wbt','u','lin','ond','bdx','ava','mor','nea','cak','das','gra','m','nig','nex','has','gt','alg','pum'];

// Strips zero-width / invisible unicode used to dodge name filters (e.g. "Stable" with
// embedded ZWSPs, cgId stable-2, scored 95 until this was added 2026-07-03).
function normalizeStr(s) {
  return (s||'').replace(/[​‌‍⁠﻿‎‏‪-‮]/g,'').trim().toLowerCase();
}

// Decide whether a single coin (from /coins/markets) qualifies for the live universe.
// excluded = map of coinId -> category label (from the category-exclusion fetch).
// counts = optional {catExcluded, volExcluded} tally object (radar's diag). Omit in the Action.
function qualifiesForUniverse(c, excluded, counts) {
  excluded = excluded || {};
  var sym = normalizeStr(c.symbol);
  var name = normalizeStr(c.name);
  // Category check first (2026-07-03) so the category count isn't shadowed by later checks.
  if(excluded[c.id]) { if(counts) counts.catExcluded++; return false; }
  if(STABLES.indexOf(sym) >= 0) return false;
  if(EXCLUDE_SYMBOLS.indexOf(sym) >= 0) return false;
  if(sym === 'btc' || sym === 'wbtc') return false;
  if(name.indexOf('usd') >= 0 || name.indexOf('dollar') >= 0) return false;
  if(c.current_price < 0.00001) return false;
  if((c.total_volume||0) < 5000000) { if(counts) counts.volExcluded++; return false; }
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STABLES: STABLES, CATEGORY_EXCLUDE: CATEGORY_EXCLUDE, EXCLUDE_SYMBOLS: EXCLUDE_SYMBOLS,
    normalizeStr: normalizeStr, qualifiesForUniverse: qualifiesForUniverse
  };
}
