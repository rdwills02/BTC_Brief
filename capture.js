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

// Symbol-collision guard (upgrade #7b, amended 2026-09-19 per work-order A3/A4). exchange-map.js
// matches Kraken/Coinbase tickers to CoinGecko coins BY TEXT, and a ticker string is not proof
// of asset identity: Kraken's "LIT" is Litentry, but the CoinGecko coin "lighter" also has
// symbol LIT and was silently pulling Litentry's candles (~$0.084-0.132) onto Lighter's real
// ~$4.73 price, scoring detection on the wrong asset entirely. exchange-map.js's own collision
// guard only catches two coins IN THE SAME UNIVERSE sharing a symbol — it can't catch this case,
// because nothing about the ticker string itself reveals that Kraken's asset behind it isn't
// the coin being mapped.
//
// `candles` here is the RAW, just-fetched pull from EX.fetchKrakenDaily/fetchCoinbaseDaily —
// deliberately checked BEFORE it's merged into the cache, not read back out of cache.ohlcDaily.
// That matters (A3): both fetchKrakenDaily and fetchCoinbaseDaily's unranged call are live,
// full re-pulls every run, so their last candle is never the frozen/partial value the #7 merge
// bug could produce — it's always today's real, current print, sampled at essentially the same
// moment as coin.current_price. That's what makes a TIGHT band safe post-#7: a real intraday
// move shows up in BOTH numbers together and the ratio stays near 1 regardless of volatility,
// so the loose 0.2x-5x band from the first pass only caught gross collisions (LIT's ~36x) and
// would pass one sitting within 5x silently — the common case, not the rare one.
//
// Two layers, cheapest first, and BOTH must pass — see R2 below for why layer 1 alone can't be
// bypassed by a good layer-2 reading:
//   1. priceSanityCheck — a same-instant ratio: reject outside 0.5x-2x, log (not reject) outside
//      0.8x-1.25x for a manual look. Cheap, no extra fetches, always available (even for a
//      brand-new coin with no cached history yet). Catches a gross scale mismatch (LIT's ~36x)
//      immediately, regardless of whether layer 2 has enough history yet.
//   2. ratioStabilityCheck (upgrade #7 work-order R2, 2026-09-19) — REPLACES the original Pearson
//      correlation on price LEVELS. That check was demonstrated (real cached data, not a
//      synthetic case) to be too weak: two unrelated but heavily co-moving alts — the exact
//      profile of most top-100 alts, which all carry meaningful BTC beta — can score 0.8-0.9+
//      Pearson on raw levels purely from moving together with the market, not from being the
//      same asset. A synthetic UNcorrelated pair is the easy case a Pearson check catches; two
//      real, correlated, similarly-priced coins are the realistic case that matters, and it did
//      not catch that one.
//
//      Ratio stability instead: for every overlapping day, r_i = exchangeClose_i / cgPrice_i.
//        - Same asset on two venues -> r_i is nearly constant (tiny, roughly fixed venue/timing
//          spread) -> LOW coefficient of variation (stdev/mean).
//        - Two different assets -> even when both trend with BTC, their INDEPENDENT idiosyncratic
//          returns compound over the window and r_i drifts -> HIGHER coefficient of variation.
//      CV is scale-invariant (divides by the mean), so a constant cross-exchange spread doesn't
//      penalize a genuine match, and unlike a same-instant ratio it can't be fooled by one lucky
//      day.
//
//      CALIBRATED against real cache data, twice — see work-order rounds 2 and 3 (2026-09-19).
//      Round 2 used 6 coins and a plain mean/stdev coefficient of variation; round 3 redid the
//      calibration on the FULL 99-coin cache and found round 2's sample had understated both
//      error modes, and that plain CV is inflated by a few outlier days on genuinely legitimate
//      coins. Round 3's findings (see test-sanity.js's R4/R5 tests, which load the exact per-coin
//      cache JSON these numbers came from):
//        - One cache file (data/cache/lighter.json) is EXCLUDED from calibration entirely — it is
//          a live, still-uncleaned example of the ORIGINAL #7b bug: its cached ohlcDaily is still
//          Litentry's price series from before this guard existed (same-instant ratio ~0.03
//          today, nowhere near 1). This is a real operational loose end, not a calibration
//          artifact — that cache file needs a manual reset once this guard ships.
//          R10 (work-order round 3 VERDICT, 2026-09-19) — EXACT SEQUENCE, do not reorder:
//            1. cache-core.js ships (the #7 merge-invariant fix).
//            2. Confirm the acceptance test: at the next capture run, data/cache/stellar.json's
//               newest daily candle must read the exchange's TRUE close, not a frozen partial
//               value — if it still reads the frozen value, the #7 fix did not take; stop and
//               fix that before going any further.
//            3. THIS FILE (capture.js — the collision guard) ships.
//            4. ONLY THEN delete data/cache/lighter.json.
//            5. Confirm it rebuilds as CoinGecko-4d-fallback-only, with no daily stream — that
//               is the CORRECT outcome for a coin with no valid exchange pair, not a regression.
//          Deleting lighter.json BEFORE step 3 (while this guard is not yet live) would simply
//          cause the very next run to re-fetch Kraken's LIT (Litentry) under the "lighter"
//          mapping and re-cache the identical wrong series — the guard, not the deletion, is
//          what actually stops the corruption from recurring; deleting first without it live
//          accomplishes nothing but a wasted API pull.
//        - Plain CV, 88 remaining coins, 90-day window: genuine self-pair range 0.006-0.318 (NOT
//          0.033-0.067 as the 6-coin round-2 sample suggested) — akedo and useless-3 alone are
//          genuinely noisy coins, not collisions, and a plain-CV reject threshold anywhere near
//          round 2's 0.10 drops them every single run.
//        - MAD-based ROBUST dispersion instead of mean/stdev CV — robust = 1.4826 *
//          median(|r_i - median(r)|) / median(r) — is far less sensitive to the handful of outlier
//          days that inflate plain CV on an otherwise-normal coin: same 88 coins, robust range
//          0.006-0.089 (akedo alone: plain CV 0.318 -> robust 0.089).
//        - Built 1102 real cross-asset pairs (every ordered pair among the 99 coins whose
//          same-instant level ratio happens to fall inside layer 1's 0.5-2.0 band — the ONLY
//          pairs layer 2 ever actually sees). At ANY threshold, a genuine coin's robust value
//          (max 0.089) and the hardest real cross-pairs (several sitting at 0.038-0.053, e.g.
//          hedera-hashgraph/algorand at 0.044-0.048) OVERLAP — no threshold cleanly separates
//          every real collision from every genuine coin. That miss is real but rare and
//          conditional (a collision must land in-band at all, which is uncommon — the one known
//          real case, LIT at ~36x, never reaches layer 2, it fails layer 1 outright) — round 3's
//          design below (RATIO_ROBUST_ACCEPT/REJECT) is explicitly biased toward NOT dropping a
//          genuine coin's daily stream over catching every possible in-band collision, since a
//          dropped genuine coin is a silent, recurring cost paid every run, while a missed in-band
//          collision is a rare, one-off cost that a human reviewing the FLAG log (see below) can
//          still catch.
function priceSanityCheck(candles, cgPrice) {
  if (!candles || !candles.length) return { ok: true, ratio: null, borderline: false };
  if (cgPrice == null || !(cgPrice > 0)) return { ok: true, ratio: null, borderline: false };
  const lastClose = candles[candles.length - 1].close;
  if (!(lastClose > 0)) return { ok: true, ratio: null, borderline: false };
  const ratio = lastClose / cgPrice;
  return { ok: ratio > 0.5 && ratio < 2, ratio: ratio, borderline: ratio <= 0.8 || ratio >= 1.25 };
}

const RATIO_MAX_POINTS = 90;   // window: unchanged from round 2 — still separates real collisions
                                // from noise better than 30d, without a full year's accumulated drift.
// R12 (work-order round 3, 2026-09-19): below this many overlapping days, don't trust a dispersion
// number — layer 2 returns null and the coin is judged on layer 1 (same-instant ratio) alone.
// Known, deliberate residual: in the full 99-coin calibration, roughly 10 coins fall short of this
// threshold (too little marketChart/ohlcDaily overlap yet) and so NEVER reach layer 2 — they are
// protected by layer 1 only, for as long as that overlap stays thin. This is not an oversight: a
// coin with under 60 days of overlap is, by definition, a recent addition to the exchange-mapped
// set (a new listing, or a coin whose exchange mapping was only just added) — and a newly-listed
// or newly-mapped ticker is exactly where a reused-symbol collision (the LIT/Litentry case this
// guard exists for) is most likely to occur, precisely because there's no track record yet to
// distinguish it by. The gap closes on its own as each coin accumulates history past 60 days; until
// then, a same-instant ratio outside 0.5x-2x is the only thing standing between capture and a
// mis-mapped ticker for these coins. Documented here so the next reader treats this as a known,
// understood tradeoff (round 3 accepted it deliberately) rather than a bug to "fix" by lowering
// RATIO_MIN_POINTS — a lower minimum would just trade this gap for a noisier, less trustworthy
// dispersion number on thin history, not close it.
const RATIO_MIN_POINTS = 60;

// Three zones now, not two (work-order round 3, R7) — deliberately biased away from dropping:
//   <= ACCEPT           : quiet accept, nothing logged (ordinary day-to-day noise)
//   ACCEPT < x <= REJECT: FLAG — still ACCEPTED (exchange data kept, nothing dropped), but logged
//                         prominently every time so a human can review it. This is where every
//                         known genuine coin's own noise ceiling (0.089) sits, and also where
//                         most of the hard-to-separate real cross-pairs sit — see the calibration
//                         note above for why the two can't be told apart by a threshold alone.
//    > REJECT           : dropped. Set safely ABOVE the full 99-coin genuine calibration max
//                         (0.089), specifically so a genuine coin's daily stream is never silently
//                         dropped by this layer — only a dispersion far outside anything a real
//                         coin has shown reaches here.
// R11 (work-order round 3, 2026-09-19): raised from the original round-3 calibration value of
// 0.04. At 0.04, 13 of 88 genuine coins (14.8%) in the full-cache calibration sat in the
// 0.04-0.12 flag band and would have logged LAYER-2 FLAG on every single run, forever, with no
// collision present — that's the exact "logs so noisy they get ignored" failure mode this
// project's own BAH-post-close-check design principle warns against. Moving the floor to 0.055
// leaves only 3 coins flagged steady-state and changes NO collision outcome versus 0.04: every
// coin in the 0.04-0.055 range was already being ACCEPTED (just also logged) at the old floor,
// so nothing that used to be dropped is now silently kept — only the noisy, uninformative half of
// the flag log goes quiet. Still well below RATIO_ROBUST_REJECT, so the reject boundary and its
// calibration (99-coin genuine max 0.089) are untouched.
const RATIO_ROBUST_ACCEPT = 0.055;  // quiet-accept ceiling (R11: raised from 0.04 to cut steady-
                                     // state flag-log noise from 13/88 genuine coins to ~3/88)
const RATIO_ROBUST_REJECT = 0.12;   // drop floor (~35% above the observed 99-coin genuine max of
                                     // 0.089 — 0 false genuine rejects in calibration; still drops
                                     // roughly half of the in-band cross-pairs outright)

// R3a: before trusting a dispersion number, confirm the two series' dates actually key-match —
// not just "look like" YYYY-MM-DD strings. Both cache-core's ymd() and exchange-ohlcv.js's own
// local ymd() happen to produce the same format today, but nothing enforces that they always
// will; a silent format drift or a systematic day-offset between them would align almost nothing
// (or align the wrong days) and produce a number that means nothing, for every coin, silently.
// Checked over the same window ratioStabilityCheck below will use, so it fails exactly when that
// window would have been garbage — the caller then falls back to priceSanityCheck instead of
// trusting a meaningless number.
function datesLookAligned(dailyCandles, marketChart, maxPoints) {
  maxPoints = maxPoints || RATIO_MAX_POINTS;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  let checked = 0, matched = 0;
  for (let i = dailyCandles.length - 1; i >= 0 && checked < maxPoints; i--) {
    const d = dailyCandles[i].date;
    if (typeof d !== 'string' || !dateRe.test(d)) return false;   // format drift — never trust it
    checked++;
    if (marketChart && Object.prototype.hasOwnProperty.call(marketChart, d)) matched++;
  }
  if (checked === 0) return true;   // nothing to check yet — not a misalignment, just no data
  return (matched / checked) >= 0.5;
}

function median(sorted) {
  const n = sorted.length, mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// R6 (work-order round 3, 2026-09-19): REPLACES round 2's plain mean/stdev coefficient of
// variation with a MAD-based robust dispersion statistic — 1.4826 * median(|r_i - median(r)|) /
// median(r) — over at most the most recent RATIO_MAX_POINTS overlapping days. The constant
// 1.4826 scales MAD to be comparable to a standard deviation under a normal distribution, which
// is what makes this threshold-compatible with the round-2 CV numbers instead of needing an
// unrelated scale. Plain CV was demonstrated (full 99-coin recalibration, see above) to be
// dominated by a handful of outlier days on otherwise-normal coins (akedo: CV 0.318, robust
// 0.089) — median-based statistics are insensitive to a few outliers in a way a mean-based one
// structurally cannot be. Returns null when there isn't enough shared, aligned history to trust
// it (see RATIO_MIN_POINTS and datesLookAligned above) — callers must fall back to
// priceSanityCheck in that case, not treat null as a rejection.
function ratioStabilityCheck(dailyCandles, marketChart, maxPoints) {
  maxPoints = maxPoints || RATIO_MAX_POINTS;
  if (!dailyCandles || !dailyCandles.length) return null;
  if (!datesLookAligned(dailyCandles, marketChart, maxPoints)) {
    console.warn('ratioStabilityCheck: exchange dates and marketChart dates do not look aligned — falling back to the ratio band rather than trusting a dispersion number computed on mismatched dates.');
    return null;
  }
  const ratios = [];
  for (let i = dailyCandles.length - 1; i >= 0 && ratios.length < maxPoints; i--) {
    const d = dailyCandles[i];
    const row = marketChart && marketChart[d.date];
    if (row && row.price != null && d.close > 0 && row.price > 0) ratios.push(d.close / row.price);
  }
  if (ratios.length < RATIO_MIN_POINTS) return null;   // not enough overlap to trust this
  const sorted = ratios.slice().sort((a, b) => a - b);
  const med = median(sorted);
  if (!(med > 0)) return null;
  const absDevs = sorted.map(r => Math.abs(r - med)).sort((a, b) => a - b);
  const mad = median(absDevs);
  return { robust: 1.4826 * mad / med, n: ratios.length };
}

// Combines both layers into one decision for pullCoin/resolveDailyCollisions. Layer 1
// (same-instant ratio) is a hard gate applied FIRST and always — a good layer-2 reading can never
// override a failing layer 1, because low dispersion is not proof of a genuine match on its own:
// a CONSTANT scale offset (the LIT case) can coincidentally have low ratio dispersion too if both
// assets happen to move similarly day to day, so layer 1's absolute-scale check and layer 2's
// stability-over-time check are complementary, not substitutable. Layer 2 only runs once layer 1
// has already passed, and (round 3, R7) now has three outcomes, not two: collision (drop),
// flagged (accept but log prominently), or clean (accept quietly) — see the zone comment above
// RATIO_ROBUST_ACCEPT/REJECT for why the boundary sits where it does.
function detectSymbolCollision(dailyCandles, cgPrice, marketChart) {
  const sanity = priceSanityCheck(dailyCandles, cgPrice);
  if (!sanity.ok) {
    return { collision: true, flagged: false, ratio: sanity.ratio, borderline: false, robust: null };
  }
  const stability = (dailyCandles && dailyCandles.length) ? ratioStabilityCheck(dailyCandles, marketChart) : null;
  if (stability != null) {
    const collision = stability.robust > RATIO_ROBUST_REJECT;
    const flagged = !collision && stability.robust > RATIO_ROBUST_ACCEPT;
    return { collision: collision, flagged: flagged, ratio: sanity.ratio, borderline: sanity.borderline, robust: stability.robust };
  }
  // Not enough history yet for layer 2 — layer 1 already passed; its own borderline zone is all
  // there is until enough overlapping days accumulate.
  return { collision: false, flagged: false, ratio: sanity.ratio, borderline: sanity.borderline, robust: null };
}

// Build the live universe using the SHARED filter. Backlog #13 (2026-09-19): this now tallies
// volExcluded/catExcluded via qualifiesForUniverse's optional `counts` arg (same mechanism
// radar.html's live-scan buildUniverse already uses - see universe-core.js) so the capture-
// sourced funnel isn't missing the two stages that happen here. Selection logic itself
// (which coins qualify) is completely unchanged - counts is purely an observed tally.
async function buildUniverse() {
  const excluded = {};
  for (const slug of U.CATEGORY_EXCLUDE) {
    const d = await cg('/coins/markets?vs_currency=usd&category=' + slug + '&per_page=250&page=1&sparkline=false');
    if (Array.isArray(d)) for (const c of d) if (!excluded[c.id]) excluded[c.id] = slug;
    await sleep(DELAY_MS);
  }
  const data = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=' + MARKETS_PER_PAGE + '&page=1&sparkline=false&price_change_percentage=24h');
  const counts = { volExcluded: 0, catExcluded: 0 };
  if (!Array.isArray(data)) return { list: [], counts: counts };
  const list = data.filter(c => U.qualifiesForUniverse(c, excluded, counts)).slice(0, UNIVERSE_SIZE);
  return { list: list, counts: counts };
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
// cache for market_chart (see header). Also FETCHES the exchange daily series (upgrade #2) if
// `mapping` is given, but does NOT decide accept/reject or merge/save it yet — that decision is
// deferred to resolveDailyCollisions() below, once every coin in the run has been pulled (upgrade
// #7 work-order R3b, 2026-09-19). Reason: a single coin's collision check can't tell a real
// collision apart from the CHECK ITSELF malfunctioning (e.g. a marketChart/date-format problem
// hitting every coin identically) — only the REJECTION RATE across the whole universe can, and
// that isn't known until every coin has been checked.
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

  // This pull's daily rows, by date, merged onto the cache — authoritative for any date/field
  // this pull covers (see cache-core.js's restated merge invariant, upgrade #7 amendment).
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

  // --- Exchange daily pull (upgrade #2, 2026-09-17). Best-effort: a failure here never aborts
  // the coin's 4-day pass, it just falls back to CoinGecko-4d for the daily stream. The
  // collision CHECK runs now (cheap, no extra fetches) so its result can feed the aggregate
  // rate resolveDailyCollisions() needs; the ACCEPT/REJECT/merge/save happens there instead. ---
  let pendingDaily = null;
  let dailyFetchFailed = false;
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
      const check = detectSymbolCollision(dailyCandles, coin.current_price, cache.marketChart);
      pendingDaily = { mapping, dailyCandles, check };
    } catch (e) {
      console.warn('daily pull failed for', coin.id, '(' + mapping.exchange + '):', e.message);
      dailyFetchFailed = true;
    }
    await sleep(EXCHANGE_DELAY_MS);
  }

  // Serve lookups from the MERGED cache (has full history even on an incremental-pull day).
  // Independent of the exchange-daily decision above — always safe to compute now.
  const volByDate = {}, capByDate = {}, priceByDate = {};
  for (const d in cache.marketChart) {
    const r = cache.marketChart[d];
    if (r.volume != null) volByDate[d] = r.volume;
    if (r.marketCap != null) capByDate[d] = r.marketCap;
    if (r.price != null) priceByDate[d] = r.price;
  }

  return {
    coin, candles, volByDate, capByDate, priceByDate, cache, pendingDaily,
    // Placeholder values until resolveDailyCollisions() runs; a coin with no mapping at all (or
    // whose fetch failed) never has anything to resolve, so its final value is set right here.
    dailySource: mapping ? (dailyFetchFailed ? (mapping.exchange + '-failed') : null) : 'coingecko-4d-fallback',
    dailyCandles: cache.ohlcDaily   // pre-resolution: whatever was already cached from a prior run
  };
}

const COLLISION_FAILOPEN_RATE = 0.10;    // R3b: this fraction of exchange-mapped coins tripping
                                          // the collision check in one run means the CHECK is
                                          // malfunctioning, not a mass symbol collision.
const COLLISION_FAILOPEN_MIN_SAMPLE = 5; // below this many mapped coins, a couple of genuine
                                          // collisions could exceed 10% by chance — too small a
                                          // sample to conclude the check itself is broken.

// R3b (upgrade #7 work-order round 2, 2026-09-19): resolve every pulled coin's exchange-daily
// accept/reject decision AFTER the whole universe has been pulled, and save every coin's cache
// exactly once. A single coin's collision check cannot distinguish a real symbol collision from
// the check malfunctioning (a stale/misaligned marketChart, a date-format regression) — only the
// REJECTION RATE across every coin that actually reached the check can, and that isn't known
// until this point. If more than COLLISION_FAILOPEN_RATE of mapped coins trip it, fail OPEN
// (log loudly, accept all exchange daily data this run) rather than dropping potentially-good
// data for the whole universe on a malfunctioning check — conservative by design, per the
// existing house rule (a missed-confirmation risk, never a false-signal risk).
// R9 (work-order round 3, 2026-09-19): the 10% fail-open trip point sits ABOVE round 2's
// measured 5% genuine false-reject rate, so the breaker alone would never have caught a genuine
// coin quietly losing its daily stream — it needed R5-R7's threshold fix (a genuine coin should
// no longer reach layer-2 REJECT at all), but that fix rests on a finite calibration sample, not
// a guarantee. Per-coin logging below is the safety net: every layer-2 REJECT is logged loudly
// with its statistic value regardless of rate, and a run-level summary line makes the total count
// visible without grepping — so a coin being dropped is visible the same run it happens, not
// discovered later from a hole in the data.
function resolveDailyCollisions(pulls) {
  const withMapping = pulls.filter(p => p.pendingDaily);
  const collided = withMapping.filter(p => p.pendingDaily.check.collision);
  const rate = withMapping.length ? collided.length / withMapping.length : 0;
  const failOpen = withMapping.length >= COLLISION_FAILOPEN_MIN_SAMPLE && rate > COLLISION_FAILOPEN_RATE;

  if (failOpen) {
    console.error(
      'COLLISION GUARD FAIL-OPEN:', collided.length, '/', withMapping.length,
      '(' + (rate * 100).toFixed(1) + '%) of exchange-mapped coins tripped the collision check ' +
      'this run. That rate means the CHECK is malfunctioning (e.g. a marketChart/date-format ' +
      'problem hitting every coin), not a mass symbol collision — accepting all exchange daily ' +
      'data this run rather than dropping it. Tripped coins:', collided.map(p => p.coin.id).join(', ')
    );
  }

  const rejectedCoins = [], flaggedCoins = [];
  for (const p of pulls) {
    if (!p.pendingDaily) { K.saveCache(CACHE_DIR, p.cache); continue; }   // no mapping, or fetch failed — nothing to resolve
    const { mapping, dailyCandles, check } = p.pendingDaily;
    const statLabel = check.robust != null
      ? ('90d robust-dispersion ' + check.robust.toFixed(3))
      : ('same-instant ratio ' + (check.ratio != null ? check.ratio.toFixed(3) : 'n/a') + ' (no robust-dispersion history yet)');
    const reject = check.collision && !failOpen;
    if (reject) {
      // R9: LAYER-2 REJECT tag specifically (distinct from a layer-1 same-instant-ratio reject)
      // is what a genuine-coin-dropped review should grep for — layer 1 rejects are expected to
      // be rare and almost always real (LIT-style); layer 2 rejects are the ones round 3's
      // calibration says should essentially never fire on a genuine coin, so any occurrence is
      // worth a look even below the fail-open breaker's 10% trip point.
      const tag = check.robust != null ? 'LAYER-2 REJECT' : 'LAYER-1 REJECT';
      console.warn(tag, '- exchange daily REJECTED for', p.coin.id, '(' + mapping.exchange + ' ticker ' + mapping.ticker + '):',
        statLabel + (check.robust != null ? (' (reject > ' + RATIO_ROBUST_REJECT + ')') : ''),
        '— looks like a different asset on a colliding ticker, not real volatility. Falling back to CoinGecko-4d for this coin.');
      rejectedCoins.push({ id: p.coin.id, tag, stat: check.robust });
      p.dailySource = mapping.exchange + '-collision';   // rejected by the collision guard, not a fetch failure
      // p.dailyCandles already holds whatever was cached before this run — nothing merged.
    } else {
      if (check.collision && failOpen) {
        console.warn('exchange daily ACCEPTED for', p.coin.id, '(' + mapping.exchange + ') UNDER FAIL-OPEN despite individually tripping the collision check — see the rate warning above.');
      } else if (check.flagged) {
        // R7: FLAG, not drop — the exchange data IS kept (dailyCandles merges normally below);
        // this is visibility only, since round 3's calibration found no threshold cleanly
        // separates a coin this noisy from a real in-band collision.
        console.warn('LAYER-2 FLAG - exchange daily ACCEPTED but flagged for', p.coin.id, '(' + mapping.exchange + ' ticker ' + mapping.ticker + '):',
          statLabel + ' (accept <= ' + RATIO_ROBUST_ACCEPT + ', reject > ' + RATIO_ROBUST_REJECT + ')',
          '— worth a manual look, not rejected.');
        flaggedCoins.push({ id: p.coin.id, stat: check.robust });
      } else if (check.borderline) {
        console.warn('exchange daily ACCEPTED but borderline for', p.coin.id, '(' + mapping.exchange + ' ticker ' + mapping.ticker + '):', statLabel, '— worth a manual look, not rejected.');
      }
      K.mergeOhlcDailyCandles(p.cache, dailyCandles);
      p.dailySource = mapping.exchange;
      p.dailyCandles = p.cache.ohlcDaily;
    }
    K.saveCache(CACHE_DIR, p.cache);   // one save, after both the 4-day and daily merges
  }

  // R9: run-level summary, visible without grepping — the whole point of this round's fix is
  // that this line should normally read "0 layer-2" every single run.
  const layer2Rejects = rejectedCoins.filter(c => c.tag === 'LAYER-2 REJECT');
  console.log(
    'collision guard summary:', rejectedCoins.length, 'rejected (' + layer2Rejects.length + ' layer-2, ' +
    (rejectedCoins.length - layer2Rejects.length) + ' layer-1), ' + flaggedCoins.length + ' flagged, of',
    withMapping.length, 'exchange-mapped coins.',
    layer2Rejects.length ? 'Layer-2 rejects: ' + layer2Rejects.map(c => c.id + ' (' + c.stat.toFixed(3) + ')').join(', ') : ''
  );
}

// Build one coin's row for the candle at index `idx` (from already-pulled series).
// OHLC is every ~4 days (CoinGecko's 365d granularity) — this is the SAME resolution the
// live radar detects on, so capture matches the system's native basis.
// Detection runs on candles UP TO AND INCLUDING idx (no look-ahead).
// Volume is SUMMED over the candle's span (from the day after the previous candle through
// this candle's date) so it represents the whole ~4-day bar, not a single day.
function rowForCandle(pulled, idx, catLabels, diag) {
  const { coin, candles, volByDate, capByDate, priceByDate } = pulled;
  if (idx < 0 || idx >= candles.length) return null;
  const bar = candles[idx];
  const D = bar.date;
  const upto = candles.slice(0, idx + 1);
  // Backlog #13 (2026-09-19): diag is optional and, when passed, tallies railPairs/posSlope/
  // touches/containment INTO THE CALLER'S shared object - same detectChannel() mechanism
  // radar.html's live scanCoin() already relies on (channel-core.js increments diag by
  // reference; a coin is counted at most once per stage - see channel-core.js's own comment).
  const det = C.detectChannel(upto, diag);          // shared detection; null if no channel

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
function rowForDaily(pulled, catLabels, diag) {
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
    dailySource: dailySource   // 'kraken' | 'coinbase' | 'coingecko-4d-fallback' | '<exchange>-failed' | '<exchange>-collision'
  };
  if (!dailyCandles || dailyCandles.length < 30) {
    return Object.assign(base, { detectionDaily: null });
  }
  // Backlog #13 (2026-09-19): "OHLC loaded" for the daily funnel means "usable daily candle
  // history reached this point" - counted here, past the length guard above, mirroring where
  // radar.html's scanCoin() counts diag.ohlcOk (right after a successful fetch, before
  // detectChannel is even called).
  if (diag) diag.ohlcOk++;
  const det = C.detectChannel(dailyCandles, diag);   // SAME shared detection as the 4-day pass —
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
  const { list: universe, counts: universeCounts } = await buildUniverse();
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

  // R3b: resolve every coin's exchange-daily accept/reject decision now that the whole universe
  // has been pulled and the aggregate collision rate is known — see resolveDailyCollisions().
  // Must run before anything below reads p.dailySource/p.dailyCandles (rowForDaily, further down).
  resolveDailyCollisions(pulls);

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
    // Backlog #13 (2026-09-19): per-date funnel tally - fresh diag per grid date, since
    // detectChannel runs on a DIFFERENT candle slice (`upto`) for each date and the gate
    // counts are therefore genuinely date-specific, unlike universeCounts/universe.length
    // above (computed once for the whole run, reused across every date's payload below).
    const diag = { ohlcOk: 0, railPairs: 0, posSlope: 0, touches: 0, containment: 0 };
    for (const p of pulls) {
      const idx = p.candles.findIndex(c => c.date === D);
      if (idx < 0) continue;                                   // coin has no candle on this grid date
      diag.ohlcOk++;                                            // coin has a usable candle on this date
      const row = rowForCandle(p, idx, catLabels, diag);
      if (row) coins.push(row);
    }
    if (!coins.length) { console.log('no coin candles on', D, '- skipping'); continue; }
    const payload = {
      date: D,
      captured_at: new Date().toISOString(),
      grid_interval_days: 4,
      backfilled: D !== newestGrid,   // only the newest closed candle is "live"; older = backfilled
      universe_count: pulls.length,
      // Backlog #13: the funnel the live Scan's Details panel already computes client-side
      // (radar.html's diag object), now computed here too so CACHED mode (the default view -
      // capture.js drives it, not a live Scan) has real numbers instead of nothing. Deliberately
      // does NOT repeat 'universe' or 'candidates' here - those already have a single source of
      // truth elsewhere (universe_count above; the merged allResults.length client-side) and
      // duplicating them into a second, independently-computed field is exactly the #7 bug
      // class (two reads of the same fact silently able to disagree) applied to a new pair of
      // numbers - see the funnel-consumer code in radar.html for how it's kept to one source.
      funnel: {
        volExcluded: universeCounts.volExcluded,
        catExcluded: universeCounts.catExcluded,
        ohlcOk: diag.ohlcOk,
        railPairs: diag.railPairs,
        posSlope: diag.posSlope,
        touches: diag.touches,
        containment: diag.containment
      },
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
    // Backlog #13 (2026-09-19): funnel tally for the daily pass - separate from the grid
    // funnel above because it's a genuinely different detection run (different candle source,
    // no independent universe re-filter, so no volExcluded/catExcluded here - this pass reuses
    // the grid pass's already-filtered coin list rather than re-running qualifiesForUniverse).
    const dailyDiag = { ohlcOk: 0, railPairs: 0, posSlope: 0, touches: 0, containment: 0 };
    const dailyCoins = pulls.map(p => {
      try {
        return rowForDaily(p, catLabels, dailyDiag);
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
      funnel: {
        ohlcOk: dailyDiag.ohlcOk,
        railPairs: dailyDiag.railPairs,
        posSlope: dailyDiag.posSlope,
        touches: dailyDiag.touches,
        containment: dailyDiag.containment
      },
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
