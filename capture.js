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
const crypto = require('crypto');          // H8 — config hash
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

// --- Remediation F1/F2 (spec 2026-09-21/22): closed-bar helpers -----------------------------
// F1: "the numbers the detector sees are closed bars, correctly stamped, from a clean feed."
// A bar is closed once its OWN span (86400s for a daily candle, 4*86400s for a CoinGecko grid
// candle) has fully elapsed since its (open-)stamped time. Applied to BOTH the exchange daily
// series (F1) and the re-stamped CoinGecko grid series (F2) via the same helper, one place,
// rather than two ad-hoc filters that could drift apart.
const DAY_SECONDS = 86400;
const GRID_SPAN_SECONDS = 4 * DAY_SECONDS;   // CoinGecko OHLC grid candle span
function isBarClosed(barTimeSec, spanSeconds, nowSec) { return barTimeSec + spanSeconds <= nowSec; }
function dropUnclosedBars(candles, spanSeconds, nowSec) {
  if (!candles || !candles.length) return candles || [];
  return candles.filter(c => isBarClosed(c.time, spanSeconds, nowSec));
}

// --- H7 candle-contract stamping (Remediation spec, 2026-09-21/22) --------------------------
// The spec's "candle" half of H7 ("each stored candle carries: venue, pair, quote currency,
// timeframe, startTime, endTime, provider timestamp and its meaning, OHLCV, isClosed,
// fetchedAt, schema version; the provider's raw record kept beside the normalized one") is
// satisfied HERE, at the point every candle is about to be merged into data/cache/<cgId>.json
// — the one place this spec text's "stored candle" actually means (cache-core.js's per-coin
// cache; radar.html's live scan never reads this file — see channel-core.js's own H7 scope
// note for the companion "fit" half). Stamping is ADDITIVE ONLY: every existing field
// ({time,open,high,low,close,date[,volume,raw]}) is left exactly as-is, so
// cache-core.js's shape-agnostic mergeOhlc/mergeOhlcDailyCandles need no changes at all, and
// nothing that already reads a cached candle's original fields is affected.
const CANDLE_SCHEMA_VERSION = 1;
function stampCandleContract(candle, opts) {
  candle.venue = opts.venue;
  candle.pair = opts.pair;
  candle.quoteCurrency = 'usd';
  candle.timeframe = opts.timeframe;
  candle.startTime = candle.time;
  candle.endTime = candle.time + opts.spanSeconds;
  candle.providerTimestamp = opts.providerTimestamp != null ? opts.providerTimestamp : candle.time;
  candle.providerTimestampMeans = opts.providerTimestampMeans;   // 'open' | 'close' — see each call site
  // Always true: stampCandleContract is only ever called on candles that already survived
  // dropUnclosedBars (grid: see pullCoin; daily/BTC: same) — an unclosed bar never reaches here.
  candle.isClosed = true;
  candle.fetchedAt = opts.fetchedAt;
  candle.schemaVersion = CANDLE_SCHEMA_VERSION;
  return candle;
}
// FIX (analysis-thread review, 2026-09-22, BLOCKS finding): stamping used to mutate the SAME
// candle objects that also flow into detectChannel and end up on the returned fit's `candles`
// field (channel-core.js's `candles.slice(-150)` — a SHALLOW slice, same object references,
// not a deep copy). Those fit-level `candles` are exactly what's written into every grid day
// file, latest.json, and latest-daily.json for radar.html to load — so the H7 candle contract
// (venue/pair/raw/etc.) was leaking into every payload the app serves on every page load, not
// staying confined to data/cache/<cgId>.json as the design (and the handoff) claimed. Measured
// on TRX: a stamped daily candle is ~3.8x a lean one; projected latest-daily.json 1.2MB -> ~7MB.
// FIX: stampCandleContractAll now clones each candle before stamping (Object.assign({}, c)) —
// it never mutates its input array's objects — so callers MUST use the returned array for the
// cache merge and keep using their ORIGINAL array for detection. See pullCoin below for both
// call sites, and toLeanCandles() further down for the second, independent safety net applied
// immediately before every detectChannel() call (covers candles reloaded from an
// already-enriched on-disk cache too, not just this run's own fresh pull).
function stampCandleContractAll(candles, opts) {
  if (!candles || !candles.length) return [];
  return candles.map(c => stampCandleContract(Object.assign({}, c), opts));
}

// Second, independent safety net (same fix as above): strips any candle down to ONLY the
// lean detection/display shape, discarding whatever contract fields it may carry — regardless
// of whether it's this run's fresh pull or a candle reloaded from an already-enriched
// data/cache/<cgId>.json file (K.loadCache can hand back H7-stamped candles from a PRIOR run,
// which stampCandleContractAll's own clone-not-mutate fix above does nothing to address).
// Applied immediately before every C.detectChannel() call in this file, so whatever ends up on
// a fit's `candles` field (and therefore in a written payload) is provably lean, independent of
// candle provenance.
const LEAN_CANDLE_FIELDS = ['time', 'open', 'high', 'low', 'close', 'date', 'volume'];
function toLeanCandle(c) {
  const lean = {};
  for (const k of LEAN_CANDLE_FIELDS) if (c[k] !== undefined) lean[k] = c[k];
  return lean;
}
function toLeanCandles(candles) { return (candles || []).map(toLeanCandle); }

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
async function pullCoin(coin, mapping, nowSec) {
  const ohlcRaw = await cg('/coins/' + coin.id + '/ohlc?vs_currency=usd&days=365');
  await sleep(DELAY_MS);

  let cache = K.loadCache(CACHE_DIR, coin.id) || K.emptyCache(coin.id, coin.symbol);
  const hasHistory = K.latestMarketChartDate(cache) !== null;
  const chartDays = hasHistory ? MARKET_CHART_INCREMENTAL_DAYS : MARKET_CHART_BACKFILL_DAYS;
  const chart = await cg('/coins/' + coin.id + '/market_chart?vs_currency=usd&days=' + chartDays + '&interval=daily');
  await sleep(DELAY_MS);
  if (!Array.isArray(ohlcRaw) || ohlcRaw.length < 30) return null;

  // F2 (Remediation spec): CoinGecko /ohlc timestamps are the CLOSE of the 4-day range, not
  // the open — every downstream date label (grid file names, row.date, pattern-band placement
  // in Plan G) was therefore off by up to 4 days. Re-stamp to the range's OPEN by subtracting
  // GRID_SPAN_SECONDS, then drop the newest candle if its re-stamped span hasn't fully closed
  // yet (F1's same closed-bar principle applied to the grid, not just the daily stream) — a
  // still-forming grid candle must never be captured as if it were a complete 4-day bar.
  // FIX (analysis-thread review, 2026-09-22, BLOCKS finding): `raw` used to be attached
  // directly on these objects at construction time — the SAME objects later sliced (not
  // deep-copied) into a detected fit's `candles` field and written into every day
  // file/latest.json. Now built in two stages: `candlesRawFull` carries `raw` (cache-bound
  // only); `candles` (below) is a LEAN copy of it via toLeanCandles(), which is what's
  // actually used for detection and returned to the caller.
  const candlesRawFull = ohlcRaw.map(c => {
    const stampSec = Math.floor(c[0] / 1000) - GRID_SPAN_SECONDS;
    // H7: keep CoinGecko's raw row (`c`) beside the normalized fields — "the provider's raw
    // record is kept beside the normalized one." Cache-bound only — see fix note above.
    return { time: stampSec, open: c[1], high: c[2], low: c[3], close: c[4], date: ymd(stampSec * 1000), raw: c };
  });
  const cacheCandlesRaw = dropUnclosedBars(candlesRawFull, GRID_SPAN_SECONDS, nowSec);
  // Detection/display-purposed array — LEAN, never carries `raw` or any H7 contract field,
  // regardless of what cacheCandlesRaw/cacheCandles carry. This is what pullCoin returns as
  // `candles` and what every detectChannel() call in this file receives.
  const candles = toLeanCandles(cacheCandlesRaw);
  // H7: stamp the full candle contract for the CACHE COPY ONLY (cacheCandlesRaw already
  // carries `raw`; stampCandleContractAll clones before stamping — see its own comment — so
  // this never touches `candles` above). providerTimestamp is the ORIGINAL CoinGecko value
  // (the range's CLOSE, per F2's header note) — c[0]/1000 — kept distinct from `time`/
  // startTime, which F2 already re-stamped to the range's OPEN; providerTimestampMeans:'close'
  // records which one the provider actually meant, per the spec's own wording ("provider
  // timestamp and its meaning"). fetchedAt is one instant for this whole pull (all grid
  // candles come from a single /ohlc response).
  const gridFetchedAt = new Date().toISOString();
  const cacheCandles = stampCandleContractAll(cacheCandlesRaw, {
    venue: 'coingecko', pair: coin.id + '/usd', timeframe: '4d-grid',
    spanSeconds: GRID_SPAN_SECONDS, providerTimestampMeans: 'close', fetchedAt: gridFetchedAt,
  });
  // providerTimestamp needs the ORIGINAL (pre-restamp) close-seconds value per candle, not a
  // single shared number — set per-clone since it depends on each candle's own time.
  cacheCandles.forEach(c => { c.providerTimestamp = c.time + GRID_SPAN_SECONDS; });

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
  K.mergeOhlc(cache, cacheCandles);   // FIX: the H7-enriched clones, not the lean `candles`

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
      // F1 (Remediation spec): both venues re-return today's still-forming bar on every call
      // (it's the live, currently-printing candle) — drop it here, before it ever reaches the
      // collision check, the cache merge, or detectChannel. Everything downstream of this line
      // only ever sees a bar whose full 86400s span has actually elapsed.
      dailyCandles = dropUnclosedBars(dailyCandles, DAY_SECONDS, nowSec);
      // FIX (analysis-thread review, 2026-09-22, BLOCKS finding): exchange-ohlcv.js's own
      // normalizers already attach `raw` on these objects at construction time (F5/H7) — the
      // SAME objects that used to be mutated further by stampCandleContractAll and then flow,
      // unchanged, into detectSymbolCollision/rowForDaily's detectChannel and out into
      // latest-daily.json's `detection.candles`. Cache-bound stamping now happens on CLONES
      // (`cacheDailyCandles`, kept separate and carrying `raw`); `dailyCandles` itself is then
      // stripped to the lean shape via toLeanCandles() and is what the collision check, the
      // returned pendingDaily, and (eventually, via rowForDaily) detection all actually see.
      // Both venues' daily OHLC endpoints timestamp at the bar's OPEN (see exchange-ohlcv.js's
      // own header, live-verified 2026-09-17), unlike CoinGecko's /ohlc — hence
      // providerTimestampMeans:'open' here vs 'close' for the grid stamp above.
      const cacheDailyCandles = stampCandleContractAll(dailyCandles, {
        venue: mapping.exchange, pair: mapping.ticker + '/usd', timeframe: '1d',
        spanSeconds: DAY_SECONDS, providerTimestampMeans: 'open', fetchedAt: new Date().toISOString()
      });
      dailyCandles = toLeanCandles(dailyCandles);   // FIX: strip to lean AFTER cloning for the cache
      const check = detectSymbolCollision(dailyCandles, coin.current_price, cache.marketChart);
      pendingDaily = { mapping, dailyCandles, cacheDailyCandles, check };
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
    const { mapping, dailyCandles, cacheDailyCandles, check } = p.pendingDaily;
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
      K.mergeOhlcDailyCandles(p.cache, cacheDailyCandles);   // FIX: the H7-enriched clones, not lean `dailyCandles`
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
  // H7: pass meta so the fit-contract fields (fitId/timeframe/source) are stamped on `det`.
  // FIX (BLOCKS finding, 2026-09-22): toLeanCandles() here is a second, independent safety net
  // — `candles` (pulled.candles) is already lean by construction (see pullCoin), but this call
  // site is exactly where a written payload's `detection.candles` is produced, so it stays
  // provably lean here even if a future change to pullCoin stops guaranteeing that upstream.
  const det = C.detectChannel(toLeanCandles(upto), diag, { coinId: coin.id, timeframe: '4d-grid', source: 'coingecko' });

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
    // F2 follow-up (review finding, 2026-09-22): F2 re-stamped grid bars to their OPEN date
    // (see this file's F1/F2 header), so priceByDate[D] - the cached daily price on date D -
    // became the price at the bar's OPEN, not its close, up to ~4 days (and, on the 9/22
    // fixture, up to 21.9%) stale relative to what the bar actually closed at. bar.close IS
    // the bar's own close - the same value H7's detectionPrice uses for the fit this row's
    // `detection` field carries (see channel-core.js's curPrice) - so this reads it directly
    // instead of going through the open-date lookup. priceByDate itself is left in place
    // (still used to build volByDate/capByDate's sibling object above); only this one read
    // changes. Confirmed on the live 9/16 TRX grid bar: priceByDate['2026-09-16'] = 0.332834
    // (that date's OPEN price) vs bar.close = 0.339764 (what F2's own acceptance test uses) -
    // a real, present-day 2.1% miss on this one bar alone, not a hypothetical.
    price: bar.close,
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
  // H7: same meta stamping as the grid pass; source here is whatever venue this coin's daily
  // stream actually came from this run (kraken/coinbase/coingecko-4d-fallback/etc).
  // FIX (BLOCKS finding, 2026-09-22): this is the REAL structural leak point — `dailyCandles`
  // here (pulled.dailyCandles) can be `p.cache.ohlcDaily`, i.e. H7-ENRICHED candles either
  // freshly merged this run or reloaded from an already-enriched on-disk cache file from a
  // PRIOR run — cloning-not-mutating upstream (pullCoin) does nothing to address that second
  // case. toLeanCandles() here strips it regardless of provenance, so detectionDaily.candles
  // (written into data/daily/*.json and latest-daily.json) is provably lean every run.
  const det = C.detectChannel(toLeanCandles(dailyCandles), diag, { coinId: coin.id, timeframe: '1d', source: dailySource });
                                                // SAME shared detection as the 4-day pass —
                                                // no separate scoring logic, no write-time
                                                // score filter (see header).
  return Object.assign(base, { detectionDaily: det });
}

// dataDir defaults to the module DATA_DIR; every call in main() below omits it. The override
// exists ONLY so the F2-migration logic below can be unit-tested against a real temp directory
// instead of the live data/ tree — see step1-invariant-tests.js.
function dayFilePath(D, dataDir) {
  const month = D.slice(0, 7);
  return path.join(dataDir || DATA_DIR, month, D + '.json');
}
function dayFileExists(D, dataDir) { return fs.existsSync(dayFilePath(D, dataDir)); }
function writeDayFile(D, obj, dataDir) {
  const p = dayFilePath(D, dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 0));
  console.log('wrote', p, '(' + obj.coins.length + ' coins, backfilled=' + obj.backfilled + ')');
}

// --- Remediation F2 migration (added per 2026-09-22 review — BLOCKS finding): every day file
// written before this fix is CLOSE-stamped (named/dated by the candle's close, per the original
// CoinGecko-timestamp bug F2 fixes). Every day file written after this fix is OPEN-stamped. The
// two conventions' filenames COLLIDE (new-label(candle_k) === old-label(candle_{k-1}), since
// candles are a fixed 4 days apart under both conventions) — without this, `dayFileExists(D)`
// would treat an old, differently-dated candle's file as "D already captured", silently
// skipping the real D and regressing `latest.json` to stale/mislabeled data forever (see the
// review's traced run-by-run walkthrough). `gridStamp: 'open'` marks every NEW-convention
// payload; its absence marks a legacy file. A legacy file found at a date the new run needs is
// migrated in place — deep-shifted by -GRID_SPAN_SECONDS (top-level date, every row's date,
// every row's detection.candles[]/pivotLows[] time+date, since those came from the same
// close-stamped candles array as everything else the OLD code wrote) and moved to its own
// correct open-stamped filename — before the real D is captured fresh. This does not migrate
// the FULL data/ tree in one shot: only files the write loop actually revisits (bounded by
// BACKFILL_CANDLES, currently the newest ~4 grid dates) get migrated, run by run, as capture.js
// naturally walks forward. Filed as BACKLOG (see handoff): older files outside that window stay
// close-stamped until something else (the step-5 harness, or a one-time batch pass) processes
// them — they are not touched by main()'s write loop, so they don't collide with anything.
function isOpenStampPayload(obj) { return !!(obj && obj.gridStamp === 'open'); }

function readDayFilePayload(D, dataDir) {
  if (!dayFileExists(D, dataDir)) return null;
  try { return JSON.parse(fs.readFileSync(dayFilePath(D, dataDir), 'utf8')); } catch (e) { return null; }
}

// Deep-shifts every GRID-candle date/time field in a legacy payload by -shiftSeconds. Never
// mutates its input. `ymdSec` mirrors the module's own `ymd()` but takes seconds (candle `time`
// fields are stored in seconds throughout this file; ymd() itself takes ms).
function ymdSec(sec) { return ymd(sec * 1000); }
function shiftGridPayloadDates(payload, shiftSeconds) {
  const migrated = JSON.parse(JSON.stringify(payload));
  function shiftCandleLike(c) {
    if (c && typeof c.time === 'number') { c.time -= shiftSeconds; c.date = ymdSec(c.time); }
  }
  if (typeof migrated.date === 'string') {
    migrated.date = ymdSec(Math.floor(Date.parse(migrated.date + 'T00:00:00Z') / 1000) - shiftSeconds);
  }
  for (const row of (migrated.coins || [])) {
    if (typeof row.date === 'string') {
      row.date = ymdSec(Math.floor(Date.parse(row.date + 'T00:00:00Z') / 1000) - shiftSeconds);
    }
    const det = row.detection;
    if (det) {
      if (Array.isArray(det.candles)) det.candles.forEach(shiftCandleLike);
      if (Array.isArray(det.pivotLows)) det.pivotLows.forEach(shiftCandleLike);
    }
  }
  return migrated;
}

// Migrates exactly ONE legacy (close-stamped) file to its corrected open-stamped filename.
// NEVER deletes captured data in favor of anything — this is a pure RELABEL-AND-RELOCATE:
// shiftGridPayloadDates only touches date/time fields, so captured_at, change24h, volume24h,
// price, detection — every point-in-time field the original capture recorded — survives
// unchanged. If the corrected path is already occupied by anything at all, this backs off
// loudly and leaves the legacy file exactly where it is, untouched, for a human to look at —
// it never overwrites or drops existing data to resolve a collision. See
// migrateAllLegacyDayFiles below for why, called oldest-first, this essentially never collides
// on the real data.
function migrateOneLegacyDayFile(legacyDate, dataDir) {
  const legacyPath = dayFilePath(legacyDate, dataDir);
  if (!fs.existsSync(legacyPath)) return;   // already moved by an earlier step this pass
  let legacyPayload;
  try { legacyPayload = JSON.parse(fs.readFileSync(legacyPath, 'utf8')); }
  catch (e) { console.warn('F2 migration: unreadable file at', legacyDate, '- leaving it in place untouched.'); return; }
  if (isOpenStampPayload(legacyPayload)) return;   // already migrated — nothing to do

  const correctedDate = ymdSec(Math.floor(Date.parse(legacyDate + 'T00:00:00Z') / 1000) - GRID_SPAN_SECONDS);
  const correctedPath = dayFilePath(correctedDate, dataDir);
  if (fs.existsSync(correctedPath)) {
    console.warn('F2 migration: corrected path for legacy', legacyDate, 'would be', correctedDate,
      'but a file already exists there — leaving', legacyDate, 'exactly as captured, untouched.',
      'Never auto-deleting captured data to resolve this; needs a manual look.');
    return;
  }
  const migrated = shiftGridPayloadDates(legacyPayload, GRID_SPAN_SECONDS);
  migrated.gridStamp = 'open';
  migrated.migratedFrom = legacyDate;
  fs.mkdirSync(path.dirname(correctedPath), { recursive: true });
  fs.writeFileSync(correctedPath, JSON.stringify(migrated, null, 0));
  fs.unlinkSync(legacyPath);
  console.log('F2 migration:', legacyDate, '(legacy close-stamp) -> corrected and moved to', correctedDate,
    '- every original captured field preserved, only date/time labels shifted.');
}

// Finds every legacy grid file under dataDir and migrates each exactly once, OLDEST FIRST — run
// as a PRE-PASS, once, before main()'s per-date write loop even starts (2026-09-22 review,
// second pass: the first version of this migrated lazily inside the write loop and, on any
// corrected-path collision, treated an already-open-stamped occupant as "superseded" and
// DELETED the legacy file — which meant a genuinely-captured historical file (including the
// frozen 9/21 audit capture, the exact data the Fable/Astra audit was built against) could be
// unlinked and replaced by a same-run reconstruction built from TODAY's live coin data, silently
// destroying its original point-in-time fields (captured_at, change24h, volume24h — see
// rowForCandle). That is now impossible: migrateOneLegacyDayFile above never deletes anything in
// favor of a fresh write, only a pure relabel. Oldest-first is what makes the real on-disk chain
// (five consecutive legacy dates, each one's corrected target being the PREVIOUS legacy date's
// own current path) resolve cleanly in a single pass with zero collisions: by the time date D is
// processed, D's corrected target (D - 4 days) was already vacated by that earlier, still-older
// date's own move, one date at a time. After this pre-pass, main()'s write loop sees a single,
// clean convention — every file it can find is either open-stamped or genuinely absent — so it
// goes back to a plain "does D's file exist" check; the per-date logic below no longer migrates
// anything itself.
function migrateAllLegacyDayFiles(dataDir) {
  if (!fs.existsSync(dataDir)) return;
  const legacyDates = [];
  for (const month of fs.readdirSync(dataDir)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const monthDir = path.join(dataDir, month);
    if (!fs.statSync(monthDir).isDirectory()) continue;
    for (const file of fs.readdirSync(monthDir)) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const payload = readDayFilePayload(m[1], dataDir);
      if (payload && !isOpenStampPayload(payload)) legacyDates.push(m[1]);
    }
  }
  legacyDates.sort();   // oldest first — see this function's header comment for why this matters
  for (const D of legacyDates) migrateOneLegacyDayFile(D, dataDir);
  if (legacyDates.length) console.log('F2 migration pre-pass: processed', legacyDates.length, 'legacy grid file(s).');
}

async function main() {
  // F2 migration pre-pass (2026-09-22 review): resolve every existing legacy grid file BEFORE
  // any network call or per-date decision — see migrateAllLegacyDayFiles' header comment. Pure
  // filesystem work, so it runs first and cheaply.
  migrateAllLegacyDayFiles(DATA_DIR);

  // F1/F2 (Remediation spec): a single "now" for the whole run, so every closed-bar decision
  // (grid and daily) this run judges against the same instant rather than drifting across the
  // run's several minutes of fetches.
  const nowSec = Math.floor(Date.now() / 1000);

  // H8 (Remediation spec): per-pass run-tracking, threaded through the rest of main() and
  // written into data/capture-manifest.json at the end. "ok" = the pass completed without
  // throwing (best-effort passes keep last-run cache data on failure — see each try/catch —
  // so ok:false does NOT mean the cache went empty, only that THIS run didn't refresh it).
  // "updated" = this run actually wrote/merged something for that pass, not just confirmed
  // nothing new was due. lastClosedCandle = the newest bar date that pass's data reflects,
  // whether from this run or a prior one.
  let gridUpdatedThisRun = false;
  let dailyPassOk = false, dailyUpdatedThisRun = false, dailyLastClosedCandle = null;
  let btcPassOk = false, btcUpdatedThisRun = false, btcLastClosedCandle = null;

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

  // F6 (Remediation spec): capture BTC's own daily series for the future market-regime gate
  // (C5, a later remediation step — this step only captures the data, C5 reads it). Fetched
  // directly against Kraken's XBTUSD pair rather than going through exchange-map/buildExchangeMap
  // — BTC/ETH are excluded from the altcoin universe those functions serve, and exchange-map's
  // generic symbol matching would map 'BTC' to the ticker string 'BTC' (see exchange-map.js's
  // ALIAS table, used only for MATCHING), not Kraken's actual 'XBT' base, which fetchKrakenDaily
  // would then send as the invalid pair 'BTCUSD'. Stored the same way every other coin's daily
  // series is stored (cache-core.js, cgId 'bitcoin' — CoinGecko's id for BTC) so C5 reads it
  // with the exact same K.loadCache() call as everything else, no new storage format. Best-
  // effort: a failure here never aborts the run — same isolation pattern as the per-coin daily
  // pull and the daily-basis-stream block below.
  try {
    const btcRaw = await EX.fetchKrakenDaily('XBT');
    const btcClosed = dropUnclosedBars(btcRaw, DAY_SECONDS, nowSec);   // lean (still carries exchange-ohlcv.js's own `raw`, stripped below)
    // H7: same candle-contract stamp as the per-coin exchange daily pull above.
    // FIX (BLOCKS finding, 2026-09-22): stampCandleContractAll clones, it no longer mutates
    // `btcClosed` in place — capture its return value for the cache merge, and lean-ify
    // `btcClosed` itself so it stays a safe, un-enriched value if a future step (C5) ever
    // detects on it directly.
    const btcCacheCandles = stampCandleContractAll(btcClosed, {
      venue: 'kraken', pair: 'XBT/usd', timeframe: '1d',
      spanSeconds: DAY_SECONDS, providerTimestampMeans: 'open', fetchedAt: new Date().toISOString()
    });
    let btcCache = K.loadCache(CACHE_DIR, 'bitcoin') || K.emptyCache('bitcoin', 'btc');
    K.mergeOhlcDailyCandles(btcCache, btcCacheCandles);
    K.saveCache(CACHE_DIR, btcCache);
    console.log('BTC daily series captured:', btcCache.ohlcDaily.length, 'candles, newest', btcClosed.length ? btcClosed[btcClosed.length - 1].date : '(none this run)');
    btcPassOk = true;
    btcUpdatedThisRun = btcClosed.length > 0;
    btcLastClosedCandle = btcCache.ohlcDaily.length ? btcCache.ohlcDaily[btcCache.ohlcDaily.length - 1].date : null;
  } catch (e) {
    console.warn('BTC daily capture failed (regime gate will have no data until this succeeds):', e.message);
  }

  // Pull each coin's series ONCE.
  const pulls = [];
  for (const coin of universe) {
    const p = await pullCoin(coin, exMap[coin.id], nowSec);
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
    // F2 migration (2026-09-22 review, second pass): migrateAllLegacyDayFiles already ran as a
    // pre-pass before this loop and resolved every legacy file it could — oldest-first, pure
    // relabel-and-relocate, never deleting. So by the time we get here there are exactly three
    // possibilities for D: (1) no file at all - write fresh; (2) an open-stamped file - already
    // captured, skip; (3) a legacy file the pre-pass explicitly backed off on (its corrected
    // target was occupied - see migrateOneLegacyDayFile) - leave it untouched and skip, never
    // overwrite captured data to force this date through. Per the review: "write only dates with
    // no file."
    const existing = readDayFilePayload(D);
    if (existing && isOpenStampPayload(existing)) {
      console.log(D, 'already captured (open-stamp) - skipping');
      continue;
    }
    if (existing && !isOpenStampPayload(existing)) {
      console.warn(D, 'legacy file still present after the migration pre-pass (backed off - see its warning above) - leaving it untouched, skipping this date this run');
      continue;
    }
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
      gridStamp: 'open',   // F2 migration marker — see migrateOneLegacyDayFile's header comment
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
    gridUpdatedThisRun = true;
    if (D === newestGrid) newestPayload = payload;
  }

  // Maintain data/latest.json -> the newest capture, so radar can load it without dir listing.
  // Always point at the newest grid date; rebuild from its file if we skipped writing it. F2
  // migration (2026-09-22 review): only trust an OPEN-stamped file here — a legacy file that
  // happens to still sit at this path (migration backed off above) must never be published as
  // "the newest capture" under a date that, for it, means something else.
  if (!newestPayload && dayFileExists(newestGrid)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(dayFilePath(newestGrid), 'utf8'));
      if (isOpenStampPayload(candidate)) newestPayload = candidate;
      else console.warn('newestGrid fallback found a legacy (non-open-stamped) file at', newestGrid, '- refusing to publish it as latest.json. The write loop above should have migrated it; investigate.');
    } catch (e) {}
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
    // F1 (Remediation spec): so the page can PROVE the last bar it detected on is closed,
    // rather than trust the pipeline. lastBarTime is the newest bar time actually present
    // across every coin's (already closed-bar-filtered, see pullCoin/dropUnclosedBars) daily
    // series feeding this run's detection — not "today", which F1 guarantees is never in
    // there. captureTime is simply when this run executed (todayDate/captured_at already
    // capture that at day resolution; this is the exact instant, for the closed-bar math).
    let lastBarTimeSec = null;
    for (const p of pulls) {
      const arr = p.dailyCandles;
      if (!arr || !arr.length) continue;
      const t = arr[arr.length - 1].time;
      if (lastBarTimeSec === null || t > lastBarTimeSec) lastBarTimeSec = t;
    }
    const dailyPayload = {
      date: todayDate,
      captureTime: new Date(nowSec * 1000).toISOString(),
      lastBarTime: lastBarTimeSec !== null ? new Date(lastBarTimeSec * 1000).toISOString() : null,
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
    dailyPassOk = true;
    dailyUpdatedThisRun = true;
    dailyLastClosedCandle = lastBarTimeSec !== null ? new Date(lastBarTimeSec * 1000).toISOString().slice(0, 10) : null;
  } catch (e) {
    console.error('DAILY-BASIS STREAM FAILED this run (4-day capture above is unaffected and will still be committed):', e);
  }

  // --- H8 capture manifest (Remediation spec, 2026-09-21/22) -----------------------------------
  // "Every capture writes source timestamps, last closed candle, fetch completion time, schema
  // version, detector version and a config hash. Failed refreshes keep the last valid data but
  // age it visibly. Refresh states which pass it updated." Written LAST, after every pass above
  // has run (or been caught) — its own file write is wrapped separately so a manifest-write
  // failure can never cost data already committed above (same failure-isolation principle the
  // daily-basis stream already uses).
  //
  // "Failed refreshes keep the last valid data but age it visibly" is satisfied by this manifest
  // EXISTING and being read-able: a pass with ok:false / updated:false alongside an unchanged
  // lastClosedCandle is exactly "aged, visibly" data — a consumer can compare fetchCompletedAt
  // against lastClosedCandle's own date to see staleness. Actually WIRING a consumer (radar.html)
  // to read and display this manifest is NOT done in this step — H8's own text only requires the
  // write. Filed as BACKLOG in the H7/H8 handoff: a future step should surface
  // capture-manifest.json's staleness in the UI (e.g. next to the "cached" data source label).
  try {
    const configHash = crypto.createHash('sha256').update(JSON.stringify({
      PIVOT_LB: C.PIVOT_LB, TOUCH_TOL: C.TOUCH_TOL, ROCKET_CLOSE_TOL: C.ROCKET_CLOSE_TOL,
      FIT_SCHEMA_VERSION: C.FIT_SCHEMA_VERSION, CONTAINMENT_RECENT_WINDOW: C.CONTAINMENT_RECENT_WINDOW,
      DETECTOR_VERSION: C.DETECTOR_VERSION, CANDLE_SCHEMA_VERSION: CANDLE_SCHEMA_VERSION,
      GRID_SPAN_SECONDS: GRID_SPAN_SECONDS, DAY_SECONDS: DAY_SECONDS, BACKFILL_CANDLES: BACKFILL_CANDLES,
      RATIO_ROBUST_ACCEPT: RATIO_ROBUST_ACCEPT, RATIO_ROBUST_REJECT: RATIO_ROBUST_REJECT,
      RATIO_MIN_POINTS: RATIO_MIN_POINTS, RATIO_MAX_POINTS: RATIO_MAX_POINTS,
      COLLISION_FAILOPEN_RATE: COLLISION_FAILOPEN_RATE, COLLISION_FAILOPEN_MIN_SAMPLE: COLLISION_FAILOPEN_MIN_SAMPLE,
      // Step 6 (Remediation spec, 2026-09-21/22; per Step 6 plan review 2026-09-22, §1): the
      // new research-mode detection constants (A1-A5/H9). capture.js itself never calls
      // detectChannel with meta.research (it always captures the flag-off reading - R3 removed
      // the process-level "research mode" concept this comment used to describe as a boolean
      // field here), so these don't change what capture.js writes - they're hashed here purely
      // so any future tuning of them is visible in configHash exactly like every existing
      // detection constant above.
      FIT_WINDOW: C.FIT_WINDOW, FIT_WINDOW_GRID: C.FIT_WINDOW_GRID, BREAK_RUN_MAX: C.BREAK_RUN_MAX,
      RECLAIM_BARS: C.RECLAIM_BARS, MIN_ANCHOR_SPAN: C.MIN_ANCHOR_SPAN,
      MIN_ANCHOR_SPAN_GRID: C.MIN_ANCHOR_SPAN_GRID, MIN_TOUCH_GAP: C.MIN_TOUCH_GAP,
      TOUCH_TOL_ATR_MULT: C.TOUCH_TOL_ATR_MULT, TOUCH_TOL_MIN: C.TOUCH_TOL_MIN, TOUCH_TOL_MAX: C.TOUCH_TOL_MAX,
      // Step 7 (Remediation spec, 2026-09-21/22; per Step 7 plan review 2026-09-22): the new
      // B1/B2 research-mode constants (independent-resistance fit, wedge lookahead,
      // recency-weighted parallel fallback). Same rationale as the Step 6 block above -
      // capture.js never sets meta.research, so these don't change what it writes; hashed
      // here so future tuning is visible in configHash like every other detection constant.
      // ACT_WIDTH_MAX and the B5 distToRailPct gate live in radar.html's buildAction, not
      // channel-core.js - not exported from this module, so not hashed here.
      NEAR_FLAT_SLOPE_PCT: C.NEAR_FLAT_SLOPE_PCT, WEDGE_LOOKAHEAD: C.WEDGE_LOOKAHEAD,
      WEDGE_LOOKAHEAD_GRID: C.WEDGE_LOOKAHEAD_GRID, RES_RECENT_BARS: C.RES_RECENT_BARS,
      RES_RECENT_BARS_GRID: C.RES_RECENT_BARS_GRID,
      // Step 8 E3 (Remediation spec, 2026-09-21/22; restage 2026-09-23): bullEngulfingResearch's
      // two new constants - same rationale as the Step 6/7 blocks above: capture.js never sets
      // meta.research (still flag-off only), so this doesn't change what it writes, hashed
      // here so any future tuning is visible in configHash like every other detection constant.
      ENGULF_BODY_ATR_MULT: C.ENGULF_BODY_ATR_MULT, ENGULF_BODY_RATIO: C.ENGULF_BODY_RATIO,
      // Step 8 E4 (Remediation spec, 2026-09-21/22): rocketAtSupportResearch's three new
      // constants - same rationale as the Step 6/7/E3 blocks above: capture.js never sets
      // meta.research (still flag-off only), so this doesn't change what it writes, hashed
      // here so any future tuning is visible in configHash like every other detection constant.
      ROCKET_WICK_BODY: C.ROCKET_WICK_BODY, ROCKET_WICK_ATR: C.ROCKET_WICK_ATR,
      ROCKET_PRIOR_CLOSES_BELOW: C.ROCKET_PRIOR_CLOSES_BELOW
    })).digest('hex');
    const manifest = {
      schemaVersion: 1,
      detectorVersion: C.DETECTOR_VERSION,
      candleSchemaVersion: CANDLE_SCHEMA_VERSION,
      configHash: configHash,
      // Step 6 build-restage review (2026-09-22, BLOCKS 3 / R3): top-level flag, not folded
      // into configHash — capture.js itself never sets meta.research (R3: capture.js stays
      // flag-off), so this is always false here. Present so a manifest reader can tell "this
      // capture ran flag-off" without having to know what a match on configHash implies.
      researchMode: false,
      fetchCompletedAt: new Date().toISOString(),
      passes: {
        // grid "ok" is always true here — a genuinely failed grid pass (empty universe, no
        // coins pulled) already process.exit(1)s above, before this point is ever reached, so
        // reaching here means the grid pass itself succeeded even on a run where every date
        // was already captured (updated:false, ok:true — "nothing new was due", not a failure).
        grid: { ok: true, lastClosedCandle: newestGrid, updated: gridUpdatedThisRun },
        daily: { ok: dailyPassOk, lastClosedCandle: dailyLastClosedCandle, updated: dailyUpdatedThisRun },
        btcRegime: { ok: btcPassOk, lastClosedCandle: btcLastClosedCandle, updated: btcUpdatedThisRun }
      }
    };
    fs.writeFileSync(path.join(DATA_DIR, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('wrote data/capture-manifest.json');
  } catch (e) {
    console.error('CAPTURE MANIFEST WRITE FAILED (data above is unaffected and will still be committed):', e);
  }

  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
