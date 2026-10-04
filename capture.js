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
let SC = null;   // 17-H section 1b: structural discovery fallback. A missing/broken structure-core.js must never stop the daily capture: the fallback is then skipped (loud warning) and rows keep their pre-17-H reason.
try { SC = require('./structure-core.js'); } catch (e) { console.warn('WARNING: structure-core.js not loaded - structural fallback disabled this run:', e.message); }
const S = require('./setups-core.js');   // Step 11-C (H5): pure setup-ledger logic; this file only does the I/O around it
const cp = require('child_process');     // forward experiment: git (single push, generation commit pins)
const EC = require('./episodes-core.js'); // forward experiment D1 (pure): candidate episodes
const OC = require('./orders-core.js');   // forward experiment D2 (pure): orders, accounts, scenarios
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
// Each is a CoinGecko category slug + the label to store. 8 extra calls/run (negligible).
const DISPLAY_CATEGORIES = [
  { slug: 'artificial-intelligence', label: 'AI' },
  { slug: 'decentralized-finance-defi', label: 'DeFi' },
  { slug: 'layer-1', label: 'Layer 1' },
  { slug: 'layer-2', label: 'Layer 2' },
  { slug: 'oracle', label: 'Oracle' },
  { slug: 'meme-token', label: 'Meme' },
  { slug: 'privacy-coins', label: 'Privacy Coin' },
  { slug: 'centralized-exchange-token-cex', label: 'Exchange' }   // 13e: last on purpose - the first matching category wins (fetchCategoryLabels), so this labels only coins no earlier category claims
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
// --- Forward pipeline repair (spec 2026-09-25): the setup ledger carries its own post-issue daily bars ---------------------
// barsByCoin = { cgId: [{id, date, open, high, low, close, venue, pair, isClosed}] } built from each pull's freshly MERGED cache
// (p.cache.ohlcDaily - the same object saved to data/cache/<cgId>.json), closed candles only, oldest first. A coin whose daily stream
// is not a successful exchange stream this run ('<exchange>-failed', '-collision', the coingecko fallback) contributes NOTHING: no bars
// this run, no mark; the next successful run appends the gap by candle id (setups-core.js append rule). No detection logic here.
function buildBarsByCoin(pulls) {
  const out = {};
  (pulls || []).forEach(p => {
    const src = p && p.dailySource;
    if (!src || /-failed$|-collision$/.test(src) || /^coingecko/.test(src)) return;
    const arr = p.cache && p.cache.ohlcDaily; if (!arr || !arr.length) return;
    const bars = [];
    arr.forEach(c => { if (c && c.isClosed === true) bars.push({ id: c.time, date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, venue: c.venue === undefined ? null : c.venue, pair: c.pair === undefined ? null : c.pair, isClosed: true }); });
    if (bars.length) out[p.coin.id] = bars;
  });
  return out;
}
// Silent-disconnect guard: >= 1 coin has a successful daily stream this run (barsByCoin non-empty) yet NONE of the open setups received any bars.
// Returns a reason string (the caller then skips the LEDGER write only - never the capture) or null.
function ledgerSilentDisconnect(priorLedger, barsByCoin) {
  if (!barsByCoin || !Object.keys(barsByCoin).length) return null;          // no successful stream anywhere: a plain outage, not a disconnect
  const open = S.normalizeLedger(priorLedger).setups.filter(x => x.status === 'open');
  if (!open.length) return null;
  const fed = open.filter(x => barsByCoin[x.cgId] && barsByCoin[x.cgId].length).length;
  return fed === 0 ? 'no open setup (' + open.length + ') received any bars while ' + Object.keys(barsByCoin).length + ' coin(s) have a successful daily stream' : null;
}
// Detection/ledger configuration hash. Body moved VERBATIM from the manifest block (no change to any hashed value); called there and for the daily file's research block.
function computeConfigHash() {
  return crypto.createHash('sha256').update(JSON.stringify({
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
      ROCKET_PRIOR_CLOSES_BELOW: C.ROCKET_PRIOR_CLOSES_BELOW,
      // Step 9 F3/H3 (Remediation spec, 2026-09-21/22): the outlier-wick clip constants - same
      // rationale as the Step 6/7/E3/E4 blocks above: capture.js never sets meta.research (flag-off
      // only) and persists no wickClips, so this doesn't change what it writes, hashed here so any
      // future tuning is visible in configHash like every other detection constant.
      F3_WICK_ATR_MULT: C.F3_WICK_ATR_MULT, F3_CLIP_ATR_MULT: C.F3_CLIP_ATR_MULT,
      F3_RAIL_UNCHANGED_PCT: C.F3_RAIL_UNCHANGED_PCT,
      // Step 10 D (Remediation spec Plan D, 2026-09-21/22): the research score-rebalance constants - same rationale as
      // the blocks above: capture.js never sets meta.research, so this doesn't change what it writes; hashed so any
      // future tuning is visible in configHash like every other detection constant.
      D_TOUCH_PTS: C.D_TOUCH_PTS, D_RES_PTS: C.D_RES_PTS, D_RES_PARALLEL_MAX: C.D_RES_PARALLEL_MAX,
      D_CONT_GATE: C.D_CONT_GATE, D_CONT_MAX: C.D_CONT_MAX, D_BREAK_PENALTY: C.D_BREAK_PENALTY,
      D_POS_MULT: C.D_POS_MULT, D_POS_FULL_CAP: C.D_POS_FULL_CAP, D_POS_PTS: C.D_POS_PTS,
      D_AGE_RANGE: C.D_AGE_RANGE, D_AGE_RANGE_GRID: C.D_AGE_RANGE_GRID, D_AGE_MAX: C.D_AGE_MAX,
      D_WIDTH_FRAC: C.D_WIDTH_FRAC, D_WIDTH_PENALTY: C.D_WIDTH_PENALTY,
      D_EMA_SLOPE_BONUS: C.D_EMA_SLOPE_BONUS, D_EMA_SLOPE_BARS: C.D_EMA_SLOPE_BARS,
      D_PATTERN_MAX: C.D_PATTERN_MAX, D_VOL_TOUCH_BONUS: C.D_VOL_TOUCH_BONUS,
      D_VOL_TOUCH_MULT: C.D_VOL_TOUCH_MULT, D_VOL_WINDOW: C.D_VOL_WINDOW, D_RAW_MAX: C.D_RAW_MAX,
      // Step 11-A (Remediation spec Plan C / C7, 2026-09-23): the research verdict-gate constants and the per-timeframe
      // ACT floors (PROVISIONAL). capture.js never computes a research verdict; hashed so any tuning is visible in
      // configHash like every other detection constant (ruling l).
      C1_EMA_SLOPE_MIN: C.C1_EMA_SLOPE_MIN, C3_FRESH_BARS: C.C3_FRESH_BARS, C3_FRESH_BARS_GRID: C.C3_FRESH_BARS_GRID,
      ACT_WIDTH_MAX: C.ACT_WIDTH_MAX, C2_DIST_TOL_MULT: C.C2_DIST_TOL_MULT, C2_DIST_CAP: C.C2_DIST_CAP,
      C4_VOLUME24H_MIN: C.C4_VOLUME24H_MIN, C4_VOL_TOUCH_MIN: C.C4_VOL_TOUCH_MIN, C5_BTC_SLOPE_MIN: C.C5_BTC_SLOPE_MIN,
      C6_SPIKE_BARS: C.C6_SPIKE_BARS, C6_SPIKE_ATR_MULT: C.C6_SPIKE_ATR_MULT, H6_RR_MIN: C.H6_RR_MIN,
      ACT_SCORE_FLOOR_1D: C.ACT_SCORE_FLOOR_1D, ACT_SCORE_FLOOR_GRID: C.ACT_SCORE_FLOOR_GRID,
      // Step 11-B (Remediation spec H6, 2026-09-23): entry-economics constants (PROVISIONAL). Research pass only; hashed
      // so any tuning is visible in configHash like every other detection constant.
      H6_ENTRY_ATR: C.H6_ENTRY_ATR, H6_STOP_ATR: C.H6_STOP_ATR, H6_STOP_CAP_ATR: C.H6_STOP_CAP_ATR, H6_COST_PCT: C.H6_COST_PCT,
      H6_SWING_WINDOW: C.H6_SWING_WINDOW, H6_SWING_WINDOW_GRID: C.H6_SWING_WINDOW_GRID,
      // Step 11-C (H5, C-1 review ruling 2): the setup ledger's close rule (setups-core.js), PROVISIONAL.
      SETUP_BREAK_CLOSES: S.SETUP_BREAK_CLOSES,
      // Step 11-D (Remediation spec H10, 2026-09-23): execution-context constants (descriptive only), PROVISIONAL.
      H10_BASELINE_BARS: C.H10_BASELINE_BARS, H10_CONTRACTION_MAX: C.H10_CONTRACTION_MAX, H10_EXPANSION_MIN: C.H10_EXPANSION_MIN
    })).digest('hex');
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

// Fetch display-category membership -> { coinId: 'Label' }. 8 calls. Context tags only.
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

  const rejectedCoins = [], flaggedCoins = [], rejectedPulls = new Set();
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
        '— looks like a different asset on a colliding ticker, not real volatility. DROPPING this coin from the universe (universe rule: a Kraken/Coinbase stream that is a different asset is not a tradeable listing).');
      rejectedCoins.push({ id: p.coin.id, tag, stat: check.robust });
      p.dailySource = mapping.exchange + '-collision';   // rejected by the collision guard, not a fetch failure
      rejectedPulls.add(p);   // universe rule: removed from `pulls` below (never tagged and kept)
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
      fwdMergeDailyImmutable(p.cache, cacheDailyCandles, m => console.warn(m));   // Protocol §0: closed candles are immutable once first fetched (a differing later value is logged and ignored); the H7-enriched clones, not lean `dailyCandles`
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
  // Universe rule: collision-rejected coins leave the universe (they are not the asset the exchange ticker trades).
  const droppedCollisions = [];
  for (let i = pulls.length - 1; i >= 0; i--) {
    if (rejectedPulls.has(pulls[i])) { droppedCollisions.unshift(droppedEntry(pulls[i].coin, DROP_COLLISION)); pulls.splice(i, 1); }
  }
  return droppedCollisions;
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
// 17-H section 1: the research fit as the detector returned it, with the four identity fields stated explicitly (all native to the fit; nothing is re-derived). A structural fit also carries structural:true,
// positionBand, lastTouchTime and its per-stage rejection counts (structure-core.js).
// 17-H Amendment A (2026-09-27): no inline candles. `fullCands` is the lean array detectChannel/detectStructure actually searched (`cands` at the call site) - same length and
// order as data/cache/<cgId>.json's ohlcDaily (both are 1:1 toLeanCandles() maps of the same p.dailyCandles/p.cache.ohlcDaily array; nothing filters between them in the non-forward
// path). fit.candles (candles.slice(-150), set by channel-core.js/structure-core.js) is therefore always fullCands' own tail slice, so its boundary in fullCands is exact, not inferred.
// candlesRef lets the page re-fetch that exact window from the cache file instead of carrying it in every daily file: firstIdx/lastIdx bound the slice, lastId + sha256 let the page
// prove the fetched slice is still the one the fit saw (sha256 over JSON.stringify([{id,open,high,low,close}, ...]) in candle order, id = candle.time - the same identifier
// pivotIds/touchEvents already use elsewhere in this codebase).
function researchDailyOf(fit, row, rejections, fullCands, pairVal) {
  const o = Object.assign({}, fit);
  const full = fullCands || [];
  const lean = toLeanCandles(fit.candles || []);
  const n = full.length, m = lean.length;
  const firstIdx = Math.max(0, n - m), lastIdx = n - 1;
  delete o.candles;
  o.timeframe = '1d'; o.candleSource = row.dailySource; o.fitId = fit.fitId; o.detectionAsOf = fit.detectionAsOf; o.detectionPrice = fit.detectionPrice;
  if (rejections) o.rejections = rejections;
  o.candlesRef = {
    path: 'data/cache/' + row.cgId + '.json',
    pair: pairVal || null,
    firstIdx: firstIdx,
    lastIdx: lastIdx,
    lastId: lean.length ? lean[lean.length - 1].time : null,
    count: m,
    sha256: crypto.createHash('sha256').update(JSON.stringify(lean.map(function (c) { return { id: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }))).digest('hex')
  };
  return o;
}
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

// Universe rule (Ryan ruling 2026-09-25, contract "Radar Capture Universe Filter"): a coin stays in the universe only if it has a
// Kraken or Coinbase daily stream. Everything else is dropped HERE, before pullCoin, so it never reaches data/latest*.json, the page,
// the setup ledger or the forward pipeline. The rejection is recorded (meta.dropped / meta.universeRule in the day files) and logged.
const UNIVERSE_RULE = 'kraken-or-coinbase';
const DROP_NO_LISTING = 'no-exchange-listing';
const DROP_COLLISION = 'ticker-collision';
function droppedEntry(coin, reason) { return { id: coin.id, symbol: String(coin.symbol || '').toUpperCase(), reason: reason }; }
function applyExchangeUniverseRule(universe, exMap) {
  const kept = [], dropped = [];
  for (const c of universe) {
    if (exMap && exMap[c.id]) kept.push(c);
    else dropped.push(droppedEntry(c, DROP_NO_LISTING));
  }
  return { kept: kept, dropped: dropped };
}
// Builds the exchange map and applies the rule. If the map build throws, the run ABORTS without writing anything: under this rule a
// silent CoinGecko-4d fallback would produce an empty capture, and the previous data files must survive instead.
async function buildExchangeUniverse(universe) {
  let exMap;
  try {
    exMap = await X.buildExchangeMap(universe.map(c => ({ id: c.id, symbol: c.symbol })));
  } catch (e) {
    console.error('FATAL: exchange-map build failed - aborting, not writing (previous data files stay as they are):', e && e.message ? e.message : e);
    process.exit(1);
    return null;
  }
  console.log('exchange map:', Object.keys(exMap).length, 'of', universe.length, 'coins mapped to Kraken/Coinbase');
  const r = applyExchangeUniverseRule(universe, exMap);
  console.log('dropped (no Kraken/Coinbase listing):', r.dropped.length, r.dropped.length ? '- ' + r.dropped.map(d => d.symbol).join(', ') : '');
  if (!r.kept.length) { console.error('no coin has a Kraken/Coinbase listing - aborting, not writing'); process.exit(1); return null; }
  return { universe: r.kept, exMap: exMap, dropped: r.dropped };
}

// ===== FORWARD-EXP BEGIN (Forward Experiment Protocol v1.2; Episodes + Policy Signals Build Spec v1.2, D3) =====================
// Everything between the BEGIN/END markers is function declarations only, parameterised by a deps object `d` = { fs, path, crypto, git, hooks, now, EC, OC },
// so the local acceptance suites (capture-forward-exp-tests.js) extract this region and run it against a real temp directory and a stubbed git.
// DORMANT until data/forward/config.json exists ({ protocolVersion, challenger }): without it capture.js behaves exactly as before (data/daily/<date>.json,
// no forward state). The cohort starts at the first canonical capture whose protocolVersion matches the config (Protocol §2: "forward state ... is reset
// to empty at the first canonical capture under the frozen protocolVersion").
var FWD_DAY = 86400;
var FWD_GATE_SEC = 600;              // a capture with issueTimeUtc before 00:10 UTC of its date is never canonical (Protocol §0)
var FWD_LOCK_WAIT_MS = 60000;        // §2: failure to acquire the lock within 60 s -> abort as an extra capture
var FWD_GEN_FILES = ['episodes.json', 'orders.json', 'accounts.json', 'scenarios.json', 'pairs.json', 'checksums.json'];

function fwdIso(ms) { return new Date(ms).toISOString(); }
// captureId = ISO wall-clock time of issueTimeUtc (basic format, colon-free so it is a legal file name) + 6 hex random.
function fwdCaptureId(issueMs, rndHex) { return fwdIso(issueMs).replace(/[-:]/g, '').replace('.', '') + '-' + rndHex; }
// The capture object. issueTimeUtc is read ONCE by the caller after all fetches complete and before pipeline step 1; date = its UTC date;
// inputCutoffUtc = 00:00 UTC of that date; a capture before 00:10 UTC is never canonical.
function fwdMakeCapture(issueMs, rndHex, protocolVersion) {
  var iso = fwdIso(issueMs), cutoffSec = Math.floor(issueMs / 1000 / FWD_DAY) * FWD_DAY;
  return { captureId: fwdCaptureId(issueMs, rndHex), issueTimeUtc: iso, inputCutoffUtc: fwdIso(cutoffSec * 1000), inputCutoffSec: cutoffSec, issueSec: Math.floor(issueMs / 1000),
    date: iso.slice(0, 10), protocolVersion: protocolVersion || null, afterCanonicalGate: Math.floor(issueMs / 1000) >= cutoffSec + FWD_GATE_SEC };
}

function fwdPaths(d, root) {
  var p = d.path, dir = p.join(root, 'forward');
  return { root: root, dir: dir, current: p.join(dir, 'CURRENT'), currentTmp: p.join(dir, 'CURRENT.tmp'), history: p.join(dir, 'CURRENT.history'), lock: p.join(dir, 'LOCK'),
    daily: p.join(root, 'daily'), edays: p.join(dir, 'episode-days'), cache: p.join(root, 'cache'), config: p.join(dir, 'config.json'), delistings: p.join(root, 'manual-delistings.json'),
    gen: function (id) { return p.join(dir, 'gen-' + id); } };
}
function fwdReadJson(d, file) { try { return JSON.parse(d.fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function fwdSha256(d, buf) { return d.crypto.createHash('sha256').update(buf).digest('hex'); }
function fwdCrash(d, name) { if (d.hooks && d.hooks.crash) d.hooks.crash(name); }
function fwdAtomicWrite(d, file, data) {   // tmp + rename
  var tmp = file + '.tmp'; d.fs.mkdirSync(d.path.dirname(file), { recursive: true });
  var fd = d.fs.openSync(tmp, 'w'); try { d.fs.writeSync(fd, data); d.fs.fsyncSync(fd); } finally { d.fs.closeSync(fd); }
  d.fs.renameSync(tmp, file);
}
function fwdReadConfig(d, root) {
  var cfg = fwdReadJson(d, fwdPaths(d, root).config);
  if (!cfg || typeof cfg.protocolVersion !== 'string' || !cfg.protocolVersion) return null;
  return { protocolVersion: cfg.protocolVersion, challenger: cfg.challenger || null };
}
function fwdReadDelistings(d, root) {
  var j = fwdReadJson(d, fwdPaths(d, root).delistings), a = Array.isArray(j) ? j : (j && Array.isArray(j.delistings) ? j.delistings : []);
  return a.filter(function (x) { return x && typeof x.cgId === 'string' && typeof x.listDate === 'string'; });
}
// The detector's research gate ids (channel-core.js researchVerdict, 16 gates in log order). A challenger's requiredGates must be a subset; a local test compares this list
// with the gate ids a real verdict emits so it cannot drift silently.
var FWD_KNOWN_GATE_IDS = ['data.fit', 'data.price', 'struct.lifecycle', 'struct.quote-breach', 'struct.below-rail', 'C1.trend', 'C3.fresh-touch', 'C3.no-recent-break', 'C7.floor', 'C2.width', 'C2.entry-zone', 'C6.spike', 'H6.rr', 'C4.volume24h', 'C4.touch-volume', 'C5.btc-regime'];
// Configuration errors abort the capture as an extra capture at startup (nothing is ever issued under a bad configuration).
// v1.4.3: the protocolVersion check is a STRICT EQUALITY list (no prefix match, no pattern): v1.4.2 and unknown strings are errors, i.e. every capture is an extra capture.
var FWD_ACCEPTED_PROTOCOLS = ['forward-experiment-v1.4.3'];
function fwdProtocolErrors(cfg) { return cfg && FWD_ACCEPTED_PROTOCOLS.indexOf(cfg.protocolVersion) < 0 ? ['protocolVersion ' + JSON.stringify(cfg.protocolVersion) + ' is not accepted by this capture.js (accepted: ' + FWD_ACCEPTED_PROTOCOLS.join(', ') + ')'] : []; }
function fwdConfigErrors(d, cfg) { return cfg ? fwdProtocolErrors(cfg).concat(d.OC.validateChallenger(cfg.challenger, FWD_KNOWN_GATE_IDS)) : []; }
function fwdHistory(d, P) {   // JSON lines, append-only: { generationId, captureId, date } and { pin: true, generationId, sha }
  var txt = ''; try { txt = d.fs.readFileSync(P.history, 'utf8'); } catch (e) { return []; }
  var out = []; txt.split('\n').forEach(function (l) { if (!l.trim()) return; try { out.push(JSON.parse(l)); } catch (e) { /* torn last line from a crash: ignored, never rewritten */ } });
  return out;
}
function fwdAppendHistory(d, P, obj) { d.fs.mkdirSync(P.dir, { recursive: true }); d.fs.appendFileSync(P.history, JSON.stringify(obj) + '\n'); }
function fwdHistoryIds(hist) { var s = {}; hist.forEach(function (h) { if (!h.pin && h.generationId) s[h.generationId] = 1; }); return s; }
function fwdPinOf(hist, id) { for (var i = hist.length - 1; i >= 0; i--) if (hist[i].pin && hist[i].generationId === id) return hist[i].sha; return null; }

// ---- advisory lock (Node has no flock(2)): exclusive create + pid-liveness stale recovery; released on unlock, stolen if the holder pid is dead ----
function fwdSleep(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* busy fallback */ var t = Date.now(); while (Date.now() - t < ms); } }
function fwdAcquireLock(d, P, waitMs) {
  var start = d.now(), tok = String(d.pid || process.pid) + ':' + start;
  d.fs.mkdirSync(P.dir, { recursive: true });
  for (;;) {
    try { var fd = d.fs.openSync(P.lock, 'wx'); d.fs.writeSync(fd, tok); d.fs.closeSync(fd); return tok; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      var holder = ''; try { holder = d.fs.readFileSync(P.lock, 'utf8'); } catch (e2) { /* vanished */ }
      var pid = parseInt(holder, 10), alive = true;
      if (pid) { try { process.kill(pid, 0); } catch (e3) { alive = e3.code === 'EPERM'; } }
      if (!alive) { try { d.fs.unlinkSync(P.lock); } catch (e4) { /* raced */ } continue; }
      if (d.now() - start >= waitMs) return null;
      fwdSleep(50);
    }
  }
}
function fwdReleaseLock(d, P, tok) { try { if (d.fs.readFileSync(P.lock, 'utf8') === tok) d.fs.unlinkSync(P.lock); } catch (e) { /* already gone */ } }

// ---- startup (Protocol §2 "Crash and re-run"): repairs only; NEVER deletes anything and never touches older daily files ----
function fwdStartup(d, root) {
  var P = fwdPaths(d, root), cur = fwdReadJson(d, P.current), hist = fwdHistory(d, P), notes = [];
  if (cur && cur.generationId && !fwdHistoryIds(hist)[cur.generationId]) {   // pointer renamed but the history append never happened
    fwdAppendHistory(d, P, { generationId: cur.generationId, captureId: cur.captureId, date: cur.date }); hist = fwdHistory(d, P); notes.push('history-repaired');
  }
  if (cur && cur.captureId) {   // <date>.json must be the winner's log: repeat the rename from <date>.<captureId>.json if absent or another capture's file
    var dayFile = d.path.join(P.daily, cur.date + '.json'), src = d.path.join(P.daily, cur.date + '.' + cur.captureId + '.json'), have = fwdReadJson(d, dayFile);
    if ((!have || have.captureId !== cur.captureId) && d.fs.existsSync(src)) { d.fs.renameSync(src, dayFile); notes.push('daily-renamed'); }
    // the immutable episode-days file follows the same rule (a crash between the daily-file rename and this one recovers both here)
    var edFile = d.path.join(P.edays, cur.date + '.json'), edSrc = d.path.join(P.edays, cur.date + '.' + cur.captureId + '.json'), edHave = fwdReadJson(d, edFile);
    if ((!edHave || edHave.captureId !== cur.captureId) && d.fs.existsSync(edSrc)) { d.fs.renameSync(edSrc, edFile); notes.push('episode-days-renamed'); }
  }
  hist.forEach(function (h) {   // pin generations whose commit is now knowable (written into THIS run's commit; a generation is pinned once)
    if (h.pin || !h.generationId || fwdPinOf(hist, h.generationId)) return;
    var gdir = P.gen(h.generationId); if (!d.fs.existsSync(gdir)) return;
    var sha = d.git ? d.git.commitAdding(d.path.join('data', 'forward', 'gen-' + h.generationId, 'checksums.json').split(d.path.sep).join('/')) : null;
    if (sha) { fwdAtomicWrite(d, d.path.join(gdir, 'commit.txt'), sha + '\n'); fwdAppendHistory(d, P, { pin: true, generationId: h.generationId, sha: sha }); notes.push('pinned:' + h.generationId); }
  });
  return { paths: P, current: cur, history: fwdHistory(d, P), notes: notes };
}
// "already processed": CURRENT (of the same cohort/protocolVersion) names a generation for this date, or this capture's date is earlier than CURRENT's.
function fwdAlreadyProcessed(cur, capture) {
  return !!(cur && cur.protocolVersion === capture.protocolVersion && cur.date && (cur.date === capture.date || capture.date < cur.date));
}

// ---- generation read/write ----
function fwdLoadGenerationFiles(d, P, id) {
  var out = { files: {}, missing: [], mismatched: [] }, gdir = P.gen(id);
  var chk = fwdReadJson(d, d.path.join(gdir, 'checksums.json'));
  if (!chk) { out.missing.push('checksums.json'); return out; }
  FWD_GEN_FILES.forEach(function (f) {
    if (f === 'checksums.json') { out.files[f] = chk; return; }
    var buf; try { buf = d.fs.readFileSync(d.path.join(gdir, f)); } catch (e) { out.missing.push(f); return; }
    if (fwdSha256(d, buf) !== (chk.files || {})[f]) out.mismatched.push(f);
    out.files[f] = JSON.parse(buf.toString('utf8'));
  });
  return out;
}
// A reader of any generation other than CURRENT resolves data/cache from the generation's pinned commit (git show <sha>:data/cache/<f>), verifying each sha256
// against those bytes, never against the working tree. CURRENT itself may be read from the working tree (its cache snapshot is the working tree's).
function fwdLoadGeneration(d, root, id, opts) {
  opts = opts || {};
  var P = fwdPaths(d, root), hist = fwdHistory(d, P), res = fwdLoadGenerationFiles(d, P, id), chk = res.files['checksums.json'];
  res.generationId = id; res.cacheChecked = 0; res.cacheMismatched = []; res.cacheUnresolvable = []; res.episodeDays = null;
  if (!chk) return res;
  // v1.3 §2: EVERY generation (CURRENT included) resolves its cache from the commit that added its checksums.json, never from the working tree
  var addSha = d.git ? d.git.commitAdding('data/forward/gen-' + id + '/checksums.json') : null, sha = addSha || fwdPinOf(hist, id);
  Object.keys(chk.cache || {}).forEach(function (rel) {
    var buf = sha ? d.git.show(sha, rel) : null;
    if (buf == null) { res.cacheUnresolvable.push(rel); return; }
    res.cacheChecked++; if (fwdSha256(d, buf) !== chk.cache[rel]) res.cacheMismatched.push(rel);
  });
  if (chk.episodeDays) {
    var eb = sha ? d.git.show(sha, chk.episodeDays.path) : null;
    res.episodeDays = eb == null ? 'unresolvable' : (fwdSha256(d, eb) === chk.episodeDays.sha256 ? 'verified' : 'mismatch');
  }
  res.verified = !res.missing.length && !res.mismatched.length && !res.cacheMismatched.length && !res.cacheUnresolvable.length && (!chk.episodeDays || res.episodeDays === 'verified');
  res.pinnedSha = sha;
  return res;
}
function fwdEmptyPrior(EC, OC) { return { episodes: EC.emptyState(), book: OC.newBook(), pairs: [] }; }
function fwdLoadPrior(d, root, startup, protocolVersion) {
  var cur = startup.current;
  if (!cur || cur.protocolVersion !== protocolVersion) return { prior: fwdEmptyPrior(d.EC, d.OC), reset: true, verified: true };
  var g = fwdLoadGenerationFiles(d, startup.paths, cur.generationId);
  if (g.missing.length || g.mismatched.length) return { prior: null, reset: false, verified: false, problems: g.missing.concat(g.mismatched) };
  var acc = g.files['accounts.json'];
  return { prior: { episodes: g.files['episodes.json'], book: { schemaVersion: g.files['orders.json'].schemaVersion, orders: g.files['orders.json'].orders, attempts: g.files['orders.json'].attempts, seq: acc.seq, accounts: acc.accounts }, pairs: g.files['pairs.json'] || [] }, reset: false, verified: true };
}

// ---- fetch list (Protocol §3): universe UNION coins with obligationCandles > 0 UNION coins with any pending or open order in either account ----
function fwdFetchList(d, prior, universeIds) {
  var set = {}; (universeIds || []).forEach(function (c) { set[c] = 1; });
  prior.episodes.episodes.forEach(function (e) { if (e.obligationCandles > 0) set[e.cgId] = 1; });
  d.OC.exposureCoins(prior.book).forEach(function (c) { set[c] = 1; });
  d.OC.obligations(prior.book).forEach(function (o) { set[o.cgId] = 1; });
  return Object.keys(set).sort();
}

// ---- immutable daily candle merge (Protocol §0: fetchedAt and the OHLC values are immutable once first fetched closed; a differing later value is logged and ignored) ----
function fwdMergeDailyImmutable(cache, candles, log) {
  var arr = cache.ohlcDaily || [], byTime = {}, i;
  for (i = 0; i < arr.length; i++) byTime[arr[i].time] = arr[i];
  (candles || []).forEach(function (c) {
    var have = byTime[c.time];
    if (!have) { byTime[c.time] = c; return; }
    if (have.open !== c.open || have.high !== c.high || have.low !== c.low || have.close !== c.close) { if (log) log('candle-diff-ignored ' + (c.pair || '') + ' ' + c.date + ' kept ' + [have.open, have.high, have.low, have.close].join('/') + ' ignored ' + [c.open, c.high, c.low, c.close].join('/')); return; }
    if (have.fetchedAt === undefined && c.fetchedAt !== undefined) have.fetchedAt = c.fetchedAt;   // legacy unstamped entry gets its first stamp; stamped entries never change
  });
  cache.ohlcDaily = Object.keys(byTime).map(function (k) { return byTime[k]; }).sort(function (a, b) { return a.time - b.time; });
  return cache;
}
// Candles usable at tauSec on the designated pair: isClosed, endTime <= tau, fetchedAt <= tau. Entries without a stamp predate every capture (legacy history) and count as usable.
function fwdUsableCandles(cacheArr, candlePair, tauSec) {
  var out = [], seen = {};
  (cacheArr || []).forEach(function (c) {
    if (!c || seen[c.time]) return;
    if (c.isClosed === false) return;
    if (candlePair && c.pair !== undefined && c.pair !== candlePair) return;
    if (c.venue !== undefined && c.venue !== 'kraken') return;
    if (c.time + FWD_DAY > tauSec) return;
    if (c.fetchedAt !== undefined) { var f = Date.parse(c.fetchedAt); if (!isFinite(f) || f / 1000 > tauSec) return; }
    seen[c.time] = 1; out.push({ id: c.time, time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, date: c.date, volume: c.volume });
  });
  return out.sort(function (a, b) { return a.time - b.time; });
}
function fwdCandlePair(pairId) { return String(pairId).replace(/USD$/, '') + '/usd'; }

// ---- Kraken metadata and quotes ----
// AssetPairs result -> { ALTNAME: { key, tick, lot, minOrder } }. tick = tick_size (the pair's PRICE precision), lot = 10^-lot_decimals, minOrder = ordermin (costmin is not applied).
function fwdParseAssetPairs(json) {
  var out = {}, r = json && json.result;
  if (!r || (json.error && json.error.length)) return out;
  Object.keys(r).forEach(function (key) {
    var v = r[key], alt = v && v.altname; if (!alt) return;
    var tick = +v.tick_size, ld = v.lot_decimals, om = +v.ordermin;
    out[alt] = { key: key, tick: isFinite(tick) && tick > 0 ? tick : null, lot: (typeof ld === 'number' && ld >= 0) ? Math.pow(10, -ld) : null, minOrder: isFinite(om) && om > 0 ? om : null, lotDecimals: typeof ld === 'number' ? ld : null };
  });
  return out;
}
function fwdParseTicker(json, assetPairs) {   // -> { ALTNAME: { last, ask, bid } }  (last = c[0], ask = a[0], bid = b[0]; ask / bid null when not a positive number; an entry needs a valid last, exactly as before)
  var out = {}, r = json && json.result; if (!r || (json.error && json.error.length)) return out;
  function px(x) { return x && isFinite(+x[0]) && +x[0] > 0 ? +x[0] : null; }
  Object.keys(assetPairs).forEach(function (alt) { var t = r[assetPairs[alt].key]; if (t && px(t.c) != null) out[alt] = { last: px(t.c), ask: px(t.a), bid: px(t.b) }; });
  return out;
}

// ---- v1.4.3 evidence adapters (Kraken public endpoints). Every function takes an injected fetchFn(url) -> parsed JSON (throws on transport / HTTP failure) so tests replay recorded responses. ----
var FWD_BAR5 = 300;
var FWD_TRADES_PAGE = 1000;       // Kraken Recent Trades returns at most 1,000 trades per page
var FWD_TRADES_MAX_PAGES = 30;
// Submission-time snapshot (Amendment §1/§2): ONE Ticker request for the pairs of the orders being issued. Kraken's Ticker carries no server timestamp, so
//   quoteObservedAtSec = request-start time rounded DOWN, tSubSec = response time rounded UP: the modelled submission instant is never earlier than the observation and never earlier than the true instant,
//   so a later print can never be moved before submission by rounding. A failed fetch / absent pair is recorded as missing with the attempted-fetch time.
async function fwdFetchQuotes(fetchFn, pairIds, assetPairs, clock) {
  var out = {}, t0 = clock(), json = null, err = null;
  try { json = await fetchFn('https://api.kraken.com/0/public/Ticker?pair=' + pairIds.join(',')); } catch (e) { err = e.message || String(e); }
  var t1 = clock(), tSub = Math.ceil(t1 / 1000), obs = Math.floor(t0 / 1000), tk = err ? {} : fwdParseTicker(json, assetPairs);
  pairIds.forEach(function (p) {
    var q = tk[p];
    if (q && q.ask != null) out[p] = { tSubSec: tSub, quoteObservedAtSec: obs, ask: q.ask, bid: q.bid, last: q.last };
    else out[p] = { tSubSec: tSub, missing: true, error: err || (json && json.error && json.error.length ? json.error.join(';') : 'pair absent or no ask in Ticker response') };
  });
  return out;
}
// OHLC interval=5: result[pairKey] = [[time, o, h, l, c, vwap, volume, count], ...] ascending, the last row is the bar in progress (the engine only uses bars with id + 300 <= issueSec).
function fwdParseOhlc5(json) {
  if (!json || (json.error && json.error.length)) return { ok: false, error: json && json.error ? json.error.join(';') : 'no response', bars: [] };
  var r = json.result, key = r ? Object.keys(r).filter(function (k) { return k !== 'last'; })[0] : null, rows = key ? r[key] : null;
  if (!Array.isArray(rows)) return { ok: false, error: 'no OHLC rows', bars: [] };
  var bars = [];
  for (var i = 0; i < rows.length; i++) {
    var x = rows[i], t = +x[0], o = +x[1], h = +x[2], l = +x[3], c = +x[4];
    if (!isFinite(t) || t % FWD_BAR5 !== 0 || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c) || l > h || o < l || o > h || c < l || c > h) return { ok: false, error: 'malformed bar at row ' + i, bars: [] };
    if (bars.length && t <= bars[bars.length - 1].id) return { ok: false, error: 'bars not strictly ascending at row ' + i, bars: [] };
    bars.push({ id: t, open: o, high: h, low: l, close: c });
  }
  return { ok: true, bars: bars, last: r.last };
}
async function fwdFetchBars5(fetchFn, pairId, sinceSec) {
  try { var pr = fwdParseOhlc5(await fetchFn('https://api.kraken.com/0/public/OHLC?pair=' + pairId + '&interval=5&since=' + sinceSec)); return pr.ok ? { ok: true, bars: pr.bars } : { ok: false, error: pr.error, bars: [] }; }
  catch (e) { return { ok: false, error: e.message || String(e), bars: [] }; }
}
// Trades: result[pairKey] = [[price, volume, time(float s), side, type, misc, trade_id], ...] ascending, result.last = continuation id (nanosecond string) to pass back verbatim as `since`.
function fwdParseTrades(json) {
  if (!json || (json.error && json.error.length)) return { ok: false, error: json && json.error ? json.error.join(';') : 'no response', trades: [] };
  var r = json.result, key = r ? Object.keys(r).filter(function (k) { return k !== 'last'; })[0] : null, rows = key ? r[key] : (r && typeof r.last === 'string' ? [] : null);
  if (!Array.isArray(rows) || !r || typeof r.last !== 'string' || !/^[0-9]+$/.test(r.last)) return { ok: false, error: 'malformed Trades response', trades: [] };
  var out = [];
  for (var i = 0; i < rows.length; i++) { var x = rows[i], p = +x[0], t = +x[2], n = x[6] == null ? null : +x[6]; if (!isFinite(p) || !isFinite(t) || (n != null && !isFinite(n))) return { ok: false, error: 'malformed trade at row ' + i, trades: [] }; out.push({ t: t, p: p, n: n }); }
  return { ok: true, trades: out, last: r.last };
}
// A slice { fromSec, toSec, complete, trades:[{t,p,n}] } claims coverage of [fromSec, toSec) ONLY when complete === true. Pagination: `since` starts one second before fromSec (nanosecond string), then each page's `last` is passed back verbatim.
//   Complete requires a venue-proven end: a print at/after toSec (coverage past the interval end), or a short last page (end of data) fetched when nowSec >= toSec. Anything else is incomplete with a reason, never an assumed no-event:
//   failed / malformed page, page budget exhausted (truncated), continuation that does not advance (continuation-stalled), trade-id gap (id-gap), time going backwards (out-of-order), a page that starts before the requested instant
//   (out-of-range: the venue answered with a different range, e.g. the most recent page - never substituted). Duplicate boundary records (same trade id on consecutive pages) are dropped; order is (time, id).
//   Precision: venue times are float seconds and compared as floats against the integer, rounded-UP submission instant, so no pre-submission print can be rounded into eligibility. The 1 s look-back only guards the boundary; prints before fromSec are discarded.
async function fwdFetchTradesSlice(fetchFn, pairId, fromSec, toSec, opts) {
  opts = opts || {}; var pageSize = opts.pageSize || FWD_TRADES_PAGE, maxPages = opts.maxPages || FWD_TRADES_MAX_PAGES, nowSec = opts.nowSec;
  var out = { fromSec: fromSec, toSec: toSec, complete: false, trades: [], pages: 0 }, seen = {}, lastId = null, maxT = -Infinity, since = String((BigInt(Math.floor(fromSec)) - 1n) * 1000000000n);
  for (var page = 1; page <= maxPages; page++) {
    var json; try { json = await fetchFn('https://api.kraken.com/0/public/Trades?pair=' + pairId + '&since=' + since); } catch (e) { out.reason = 'page-' + page + '-failed: ' + (e.message || e); return out; }
    var pr = fwdParseTrades(json); out.pages = page;
    if (!pr.ok) { out.reason = 'page-' + page + '-failed: ' + pr.error; return out; }
    var covered = false, added = 0;
    for (var i = 0; i < pr.trades.length; i++) {
      var x = pr.trades[i];
      if (x.n != null && seen[x.n]) continue;                      // overlapping boundary record: already taken
      if (x.t < maxT) { out.reason = 'out-of-order at page ' + page; return out; }
      if (page === 1 && i === 0 && x.t < fromSec - 1) { out.reason = 'out-of-range: first print ' + x.t + ' precedes the requested instant ' + fromSec; return out; }
      maxT = x.t;
      if (x.n != null) {
        if (lastId != null && x.n !== lastId + 1) { out.reason = 'id-gap: ' + lastId + ' -> ' + x.n + ' at page ' + page; return out; }
        seen[x.n] = 1; lastId = x.n;
      }
      if (x.t >= toSec) { covered = true; continue; }
      if (x.t >= fromSec) { out.trades.push({ t: x.t, p: x.p, n: x.n }); added++; }
    }
    if (covered) { out.complete = true; break; }
    if (pr.trades.length < pageSize) {                            // end of data: the interval is covered only if it is already in the past
      if (isFinite(nowSec) && nowSec >= toSec) { out.complete = true; break; }
      out.reason = 'end of data before the interval end (interval not yet over)'; return out;
    }
    if (!(BigInt(pr.last) > BigInt(since))) { out.reason = 'continuation-stalled at page ' + page; return out; }
    since = pr.last;                                              // verbatim
  }
  if (!out.complete && !out.reason) out.reason = 'truncated: ' + maxPages + ' pages without reaching the interval end';
  out.trades.sort(function (a, b) { return a.t - b.t || ((a.n == null ? 0 : a.n) - (b.n == null ? 0 : b.n)); });
  return out;
}

// ---- research row for D1/D2, built from the detector's own fit and verdict as logged ----
// v1.4: `structuralFit` (structure-core's winner, whatever its positionBand) is accepted ONLY as continuity evidence
// for episodes-core - it is written to the row's `structuralFit` field, never `fit`, and only when `fit` is null
// (the caller guarantees this; see capture.js's forward-update wiring). `fit` null + `structuralFit` present still
// means: no policy fit this capture - the §3 screen, opening and every predicate (which read row.fit only) see NOFIT
// exactly as before v1.4. A caller that never passes `structuralFit` gets byte-identical v1.3 rows.
function fwdResearchRow(fit, res, summary, price, structuralFit) {
  if (!fit && !structuralFit) return null;
  var ee = fit && fit.entryEconomics || null;
  function lean(f) { return { fitId: f.fitId, pivotIds: f.pivotIds || [], supSlope: f.supSlope, supIntercept: f.supIntercept, supportNow: f.supportNow, invalidation: f.invalidation, atr14: f.atr14, resistNow: f.resistNow,
    channelH: f.channelH, supportTouches: f.supportTouches, lifecycleState: f.lifecycleState }; }
  return { fit: fit ? lean(fit) : null, structuralFit: (!fit && structuralFit) ? lean(structuralFit) : null,
    price: price, gates: (summary && summary.gates) || null, score: fit && typeof fit.score === 'number' ? fit.score : null,
    entryEconomics: ee ? { entryZone: ee.entryZone, entryRef: ee.entryRef, defendedLow: ee.defendedLow, stop: ee.stop, stopBasis: ee.stopBasis, target: ee.target, targetSource: ee.targetSource, netRR: ee.netRR, grossRR: ee.grossRR, atr14: ee.atr14 } : null };
}

// ---- one canonical capture's forward update (Protocol §4.0 steps 1-7). Pure given its inputs. ----
// inputs.coins = { cgId: { pair, venueEligible, metadataEligible, meta:{tick,lot,minOrder}|null, candles:[usable at issueTimeUtc], research: row|null } }
function fwdRunUpdate(d, prior, capture, inputs, cfg) {
  var EC = d.EC, OC = d.OC, bars = {}, i;
  var evBars = {};   // orders-core evidence: daily candles plus (v1.4.3) 5-minute bars and Trades slices; episodes-core keeps seeing the daily-only objects
  Object.keys(inputs.coins).forEach(function (cg) { var c = inputs.coins[cg]; bars[cg] = { pair: c.pair, venueEligible: c.venueEligible, metadataEligible: c.metadataEligible, candles: c.candles }; evBars[cg] = { candles: c.candles, bars5: c.bars5 || [], trades: c.trades || [] }; });
  var needs = cfg.needs || [];
  var book = OC.adjudicateAll(prior.book, capture, evBars, { needs: needs });   // step 2 (step 3, activation, is retired in v1.4.3: an order is submitted at issuance)
  ['N0', 'C1'].forEach(function (p) { book = OC.valuation(book, p, capture, evBars); book = OC.suspend(book, p, capture); });   // steps 4, 5
  var rows = {}; Object.keys(inputs.coins).forEach(function (cg) { if (inputs.coins[cg].research) rows[cg] = inputs.coins[cg].research; });
  var eu = EC.updateEpisodes(prior.episodes, capture, rows, bars, inputs.universeIds || [], OC.obligations(book), { manualDelistings: cfg.manualDelistings || [] });   // step 6
  var cands = eu.episodeDays.map(function (ed) {
    var c = inputs.coins[ed.cgId] || {};
    return { episodeId: ed.episodeId, cgId: ed.cgId, pair: ed.pair, screen: ed.screen, price: ed.price, score: ed.score, entryEconomics: ed.entryEconomics, venueEligible: ed.venueEligible !== false, gates: ed.gates || null, meta: c.metadataEligible === false ? null : (c.meta || null) };
  });
  var results = {};
  ['N0', 'C1'].forEach(function (p) {                                           // step 7
    var r = OC.issueBatch(book, { id: p, version: p === 'N0' ? 'N0-v1' : ((cfg.challenger && cfg.challenger.version) || 'C1-unconfigured') }, cands, capture, { challenger: cfg.challenger || null, quotes: cfg.quotes || {}, needs: needs });
    book = r.book; results[p] = { results: r.results, blockedReason: r.blockedReason };
  });
  return { episodes: eu.state, book: book, episodeDays: eu.episodeDays, episodeDayRows: eu.episodeDayRows, results: results, obligations: eu.obligations };
}
function fwdUpdatePairs(pairs, capture, coinsWithPair) {   // pair fixed at the coin's first eligible canonical capture and never changes
  var have = {}; pairs.forEach(function (p) { have[p.cgId] = p; });
  var out = pairs.slice();
  Object.keys(coinsWithPair).sort().forEach(function (cg) { if (!have[cg] && coinsWithPair[cg]) out.push({ cgId: cg, pair: coinsWithPair[cg], fixedAtCaptureId: capture.captureId }); });
  return out.sort(function (a, b) { return a.cgId < b.cgId ? -1 : a.cgId > b.cgId ? 1 : 0; });
}

// ---- the commit sequence (Protocol §2), in this exact order:
// [caller] write data/daily/<date>.<captureId>.json  ->  write the candle cache tmp+rename  ->  write the six generation files  ->  verify checksums (failure: abort, extra)
//  ->  exclusive lock on data/forward/LOCK (60 s; failure: abort, extra)  ->  re-read CURRENT (changed since startup: abort, extra)  ->  CURRENT.tmp + rename
//  ->  append CURRENT.history  ->  rename the daily file to <date>.json  ->  delete remnants  ->  release the lock  ->  git add/commit/push (rejected: abort, extra; no rebase, no force)
// gen = { episodes, orders, accounts, scenarios, pairs } objects. Returns { status: 'canonical' | 'extra' | 'push-rejected', reason?, sha? }.
// gen = { episodes, orders, accounts, scenarios, pairs, episodeDays } objects; gen.episodeDays = { schemaVersion, captureId, date, rows } is the immutable per-capture episode-day file (Protocol v1.3 §2).
// An abort before the pointer rename deletes THIS run's own partial gen-* directory and episode-days file (never anything else) so an extra capture leaves no remnants.
function fwdCleanupOwn(d, root, capture) {
  var P = fwdPaths(d, root);
  try { d.fs.rmSync(P.gen(capture.captureId), { recursive: true, force: true }); } catch (e) { /* best effort */ }
  try { d.fs.rmSync(d.path.join(P.edays, capture.date + '.' + capture.captureId + '.json'), { force: true }); } catch (e) { /* best effort */ }
}
function fwdCommitSequence(d, root, capture, startupCurrent, gen, opts) {
  var P = fwdPaths(d, root), dayTmp = d.path.join(P.daily, capture.date + '.' + capture.captureId + '.json'), edTmp = d.path.join(P.edays, capture.date + '.' + capture.captureId + '.json'), edFinal = d.path.join(P.edays, capture.date + '.json'), tok = null;
  var abort = function (reason) { fwdCleanupOwn(d, root, capture); return { status: 'extra', reason: reason }; };
  fwdCrash(d, 'after-daily-write');
  // candle cache: every cache file rewritten tmp+rename; its sha256 goes into checksums.json
  var cacheSha = {}, names = []; try { names = d.fs.readdirSync(P.cache).filter(function (f) { return /\.json$/.test(f); }).sort(); } catch (e) { names = []; }
  names.forEach(function (f) { var file = d.path.join(P.cache, f), buf = d.fs.readFileSync(file); fwdAtomicWrite(d, file, buf); cacheSha['data/cache/' + f] = fwdSha256(d, buf); });
  fwdCrash(d, 'after-cache-write');
  // the immutable episode-days file (written under its capture-specific name, renamed to <date>.json after the pointer rename; its checksum names the FINAL path, which is what the commit contains)
  var edTxt = JSON.stringify(gen.episodeDays || { schemaVersion: 1, captureId: capture.captureId, date: capture.date, rows: [] }), edSha = fwdSha256(d, Buffer.from(edTxt, 'utf8'));
  fwdAtomicWrite(d, edTmp, edTxt);
  fwdCrash(d, 'after-episode-days-write');
  // generation files: episodes, orders, accounts, scenarios, pairs, then checksums (each written tmp+rename)
  var gdir = P.gen(capture.captureId), texts = {}, files = {};
  var body = { 'episodes.json': gen.episodes, 'orders.json': gen.orders, 'accounts.json': gen.accounts, 'scenarios.json': gen.scenarios, 'pairs.json': gen.pairs };
  FWD_GEN_FILES.forEach(function (f, n) {
    var txt;
    if (f === 'checksums.json') { txt = JSON.stringify({ generationId: capture.captureId, protocolVersion: capture.protocolVersion, files: files, episodeDays: { path: 'data/forward/episode-days/' + capture.date + '.json', sha256: edSha }, cache: cacheSha }); }
    else { txt = JSON.stringify(body[f]); files[f] = fwdSha256(d, Buffer.from(txt, 'utf8')); }
    texts[f] = txt; fwdAtomicWrite(d, d.path.join(gdir, f), txt);
    fwdCrash(d, 'after-gen-file-' + (n + 1));
  });
  // verify: recompute every checksum from disk
  var bad = [];
  FWD_GEN_FILES.forEach(function (f) { if (f === 'checksums.json') return; var b; try { b = d.fs.readFileSync(d.path.join(gdir, f)); } catch (e) { bad.push(f); return; } if (fwdSha256(d, b) !== files[f]) bad.push(f); });
  Object.keys(cacheSha).forEach(function (rel) { var b; try { b = d.fs.readFileSync(d.path.join(root, '..', rel)); } catch (e) { bad.push(rel); return; } if (fwdSha256(d, b) !== cacheSha[rel]) bad.push(rel); });
  (function () { var b; try { b = d.fs.readFileSync(edTmp); } catch (e) { bad.push('episode-days'); return; } if (fwdSha256(d, b) !== edSha) bad.push('episode-days'); })();
  if (bad.length) return abort('checksum-verify-failed: ' + bad.join(','));
  fwdCrash(d, 'after-verify');
  fwdCrash(d, 'before-lock');   // test seam: another run may complete here
  tok = fwdAcquireLock(d, P, opts && opts.lockWaitMs != null ? opts.lockWaitMs : FWD_LOCK_WAIT_MS);
  if (!tok) return abort('lock-timeout');
  try {
    var nowCur = fwdReadJson(d, P.current);
    if (JSON.stringify(nowCur) !== JSON.stringify(startupCurrent || null)) return abort('current-changed-since-startup');
    fwdCrash(d, 'before-current-rename');
    fwdAtomicWrite(d, P.current, JSON.stringify({ generationId: capture.captureId, captureId: capture.captureId, date: capture.date, protocolVersion: capture.protocolVersion }));
    fwdCrash(d, 'after-current-rename');
    fwdAppendHistory(d, P, { generationId: capture.captureId, captureId: capture.captureId, date: capture.date });
    fwdCrash(d, 'after-history-append');
    if (d.fs.existsSync(dayTmp)) d.fs.renameSync(dayTmp, d.path.join(P.daily, capture.date + '.json'));
    fwdCrash(d, 'after-daily-rename');
    if (d.fs.existsSync(edTmp)) d.fs.renameSync(edTmp, edFinal);
    fwdCrash(d, 'after-episode-days-rename');
    // remnants: gen-* directories (and episode-days files) neither listed in CURRENT.history nor named in CURRENT; deleted only after THIS run's own pointer rename
    var ids = fwdHistoryIds(fwdHistory(d, P)), curNow = fwdReadJson(d, P.current);
    d.fs.readdirSync(P.dir).forEach(function (n) {
      var m = /^gen-(.+)$/.exec(n); if (!m) return;
      if (ids[m[1]] || (curNow && curNow.generationId === m[1])) return;
      d.fs.rmSync(d.path.join(P.dir, n), { recursive: true, force: true });
    });
    try { d.fs.readdirSync(P.edays).forEach(function (n) { var m = /^\d{4}-\d{2}-\d{2}\.(.+)\.json$/.exec(n); if (!m) return; if (ids[m[1]] || (curNow && curNow.generationId === m[1])) return; d.fs.rmSync(d.path.join(P.edays, n), { force: true }); }); } catch (e) { /* no episode-days directory */ }
    fwdCrash(d, 'after-remnant-delete');
  } finally { fwdReleaseLock(d, P, tok); }
  if (d.git && !(opts && opts.noGit)) {
    var pr = d.git.commitAndPush('Daily capture - ' + capture.date + ' ' + capture.issueTimeUtc.slice(11, 16) + ' UTC (canonical ' + capture.captureId + ')');
    if (!pr.ok) return { status: 'push-rejected', reason: pr.reason || 'push rejected' };
    return { status: 'canonical', sha: pr.sha };
  }
  return { status: 'canonical', sha: null };
}
// ===== FORWARD-EXP END =====================================================================================================

// ---- real dependencies for the forward experiment (I/O; outside the extracted region) ----
function fwdRealGit() {
  const run = (args, opts) => cp.execFileSync('git', ['-c', 'user.name=radar-capture-bot', '-c', 'user.email=actions@github.com'].concat(args),
    Object.assign({ cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 }, opts || {}));
  return {
    // The commit that ADDED rel (the generation's checksums.json): the pin for that generation's cache snapshot. actions/checkout is shallow (depth 1), where git log
    // reports the graft boundary as the adding commit, so a hit is trusted only if it has a real parent (or the repo is complete); otherwise deepen and retry.
    commitAdding(rel) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const sha = run(['log', '-n', '1', '--diff-filter=A', '--format=%H', '--', rel]).toString().trim();
          let shallow = false; try { shallow = run(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true'; } catch (e) { /* older git: treat as complete */ }
          if (sha) { let hasParent = true; try { run(['rev-parse', '--verify', '--quiet', sha + '^']); } catch (e) { hasParent = false; } if (!shallow || hasParent) return sha; }
        } catch (e) { /* fall through to deepen */ }
        try { run(['fetch', '--deepen=25']); } catch (e) { break; }
      }
      return null;
    },
    show(sha, rel) { try { return run(['show', sha + ':' + rel]); } catch (e) { return null; } },
    // The run's single push. A rejected (non-fast-forward) push aborts as an extra capture: no rebase, no force, ever.
    commitAndPush(msg) {
      try {
        run(['add', 'data/']); run(['commit', '-m', msg]);
        const sha = run(['rev-parse', 'HEAD']).toString().trim();
        try { run(['push']); } catch (e) { return { ok: false, reason: 'git push failed: ' + String((e.stderr && e.stderr.toString()) || e.message).slice(0, 300) }; }
        return { ok: true, sha };
      } catch (e) { return { ok: false, reason: 'git commit failed: ' + String((e.stderr && e.stderr.toString()) || e.message).slice(0, 300) }; }
    }
  };
}
function fwdRealDeps() { return { fs, path, crypto, EC, OC, now: () => Date.now(), pid: process.pid, hooks: null, git: fwdRealGit() }; }
// Kraken AssetPairs (tick_size, lot_decimals, ordermin) + Ticker (last trade) for the designated pairs, fetched once per capture.
async function fwdFetchKrakenInfo(pairIds) {
  const info = { assetPairs: {}, prices: {}, quotes: {}, priceFetchedAt: null, errors: [] };
  if (!pairIds.length) return info;
  try {
    const r = await fetch('https://api.kraken.com/0/public/AssetPairs'); const all = fwdParseAssetPairs(await r.json());
    pairIds.forEach(p => { if (all[p]) info.assetPairs[p] = all[p]; });
  } catch (e) { info.errors.push('AssetPairs: ' + e.message); }
  try {
    const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=' + pairIds.join(',')); info.quotes = fwdParseTicker(await r.json(), info.assetPairs);   // decision input only (never execution evidence)
    Object.keys(info.quotes).forEach(alt => { info.prices[alt] = info.quotes[alt].last; });
    info.priceFetchedAt = new Date().toISOString();
  } catch (e) { info.errors.push('Ticker: ' + e.message); }
  return info;
}
// Coins outside this run's universe that still owe bars (open episode obligations, pending or open orders): daily candles only, no CoinGecko calls.
async function fwdLightPull(cgId, pairId, nowSec) {
  const ticker = String(pairId).replace(/USD$/, '');
  const closed = dropUnclosedBars(await EX.fetchKrakenDaily(ticker), DAY_SECONDS, nowSec);
  const stamped = stampCandleContractAll(closed, { venue: 'kraken', pair: ticker + '/usd', timeframe: '1d', spanSeconds: DAY_SECONDS, providerTimestampMeans: 'open', fetchedAt: new Date().toISOString() });
  const cache = K.loadCache(CACHE_DIR, cgId) || K.emptyCache(cgId, '');
  fwdMergeDailyImmutable(cache, stamped, m => console.warn(m));
  K.saveCache(CACHE_DIR, cache);
  return cache;
}

async function main() {
  // F2 migration pre-pass (2026-09-22 review): resolve every existing legacy grid file BEFORE
  // any network call or per-date decision — see migrateAllLegacyDayFiles' header comment. Pure
  // filesystem work, so it runs first and cheaply.
  migrateAllLegacyDayFiles(DATA_DIR);

  // Forward experiment (Protocol v1.2 §2). DORMANT unless data/forward/config.json exists. Startup only repairs (history, daily-file rename, commit pins); it never deletes.
  const fwdDeps = fwdRealDeps();
  const fwdCfg = fwdReadConfig(fwdDeps, DATA_DIR);
  const fwdCfgErrors = fwdCfg ? fwdConfigErrors(fwdDeps, fwdCfg) : [];   // a bad challenger configuration makes every capture an extra capture: nothing is ever issued
  if (fwdCfgErrors.length) console.error('forward: CONFIGURATION ERROR in data/forward/config.json - ' + fwdCfgErrors.join('; ') + ' - EXTRA CAPTURE, no forward update');
  let fwdStart = null;
  if (fwdCfg) {
    try { fwdStart = fwdStartup(fwdDeps, DATA_DIR); console.log('forward: startup', fwdStart.notes.join(',') || 'clean', '| CURRENT', fwdStart.current ? fwdStart.current.generationId : '(none)'); }
    catch (e) { console.error('forward: startup failed - this run is an extra capture:', e.message); }
  }

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
  let btcRegime = null;   // Step 11-A / C5: btcRegimeFromCandles(btcCache.ohlcDaily) - written into latest-daily.json and the manifest
  let researchRows = null;   // Step 11-C (H5): per-coin research verdict rows for the setup ledger (built in the daily pass below)
  let setupsSummary = null;  // Step 11-C: {opened, closed, open} for the manifest

  const builtUniverse = await buildUniverse();
  let universe = builtUniverse.list;
  const universeCounts = builtUniverse.counts;
  console.log('universe:', universe.length, 'coins');
  if (!universe.length) { console.error('empty universe — aborting, not writing'); process.exit(1); }

  // Display-category labels (context tags). 8 calls.
  const catLabels = await fetchCategoryLabels();
  console.log('category labels for', Object.keys(catLabels).length, 'coins');

  // Exchange ticker map (upgrade #2, 2026-09-17) - 2 calls, rebuilt fresh every run since the universe rotates. Universe rule
  // (2026-09-25): a failure here now ABORTS the run (nothing written), and coins with no Kraken/Coinbase listing are dropped.
  const exu = await buildExchangeUniverse(universe);
  const exMap = exu.exMap;
  universe = exu.universe;
  const droppedNoListing = exu.dropped;

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
    fwdMergeDailyImmutable(btcCache, btcCacheCandles, m => console.warn(m));
    K.saveCache(CACHE_DIR, btcCache);
    console.log('BTC daily series captured:', btcCache.ohlcDaily.length, 'candles, newest', btcClosed.length ? btcClosed[btcClosed.length - 1].date : '(none this run)');
    btcPassOk = true;
    btcUpdatedThisRun = btcClosed.length > 0;
    btcLastClosedCandle = btcCache.ohlcDaily.length ? btcCache.ohlcDaily[btcCache.ohlcDaily.length - 1].date : null;
    // Step 11-A (Remediation spec C5): the BTC regime the page and the runner gate on. One core helper
    // (channel-core.js btcRegimeFromCandles: emaLast(50) + the D_EMA_SLOPE_BARS slope, same definition as the alt
    // ema50Slope) evaluated here on the merged closed-bar series, so capture, page and runner cannot disagree.
    // Written as top-level `btcRegime` on latest-daily.json (the page already fetches that file) and into the
    // manifest's passes.btcRegime beside ok/lastClosedCandle/updated. Null when the series is empty.
    btcRegime = C.btcRegimeFromCandles(btcCache.ohlcDaily);
    console.log('BTC regime:', btcRegime ? ('close ' + btcRegime.close + ' ema50 ' + (btcRegime.ema50 != null ? btcRegime.ema50.toFixed(1) : 'n/a') + ' slope ' + (btcRegime.ema50Slope != null ? (btcRegime.ema50Slope * 100).toFixed(2) + '%' : 'n/a') + ' above ' + btcRegime.aboveEma50) : 'null');
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
  const droppedCollisions = resolveDailyCollisions(pulls);
  if (droppedCollisions.length) console.warn('dropped (ticker collision):', droppedCollisions.length, '-', droppedCollisions.map(d => d.symbol).join(', '));
  const droppedAll = droppedNoListing.concat(droppedCollisions);   // written as meta.dropped
  console.log('dropped (not tradeable on Kraken/Coinbase):', droppedAll.length, droppedAll.length ? '- ' + droppedAll.map(d => d.symbol).join(', ') : '');
  {   // invariant: every remaining coin has an exchange mapping (no CoinGecko-4d fallback rows can exist any more)
    const unmapped = pulls.filter(p => !exMap[p.coin.id]);
    if (unmapped.length) { console.error('BUG: coins without an exchange mapping survived the universe rule:', unmapped.map(p => p.coin.id).join(', '), '- aborting, not writing'); process.exit(1); }
  }

  // ---- Forward experiment fetch phase (Protocol §3 fetch list = universe UNION obligations UNION pending/open orders) and the capture object ----
  let fwdPrior = null, fwdInfo = null;
  const fwdLight = {}, fwdPairIdOf = {}, fwdResearchByCoin = {};
  let fwdFetchIds = [];
  if (fwdCfg && fwdStart) {
    try {
      const lp = fwdLoadPrior(fwdDeps, DATA_DIR, fwdStart, fwdCfg.protocolVersion);
      if (!lp.verified) console.error('forward: CURRENT generation failed verification (' + lp.problems.join(',') + ') - extra capture only');
      else fwdPrior = lp.prior;
    } catch (e) { console.error('forward: could not load prior state - extra capture only:', e.message); }
    const fixed = {}; ((fwdPrior && fwdPrior.pairs) || []).forEach(x => { fixed[x.cgId] = x.pair; });
    pulls.forEach(p => { const m = exMap[p.coin.id]; fwdPairIdOf[p.coin.id] = fixed[p.coin.id] || ((m && m.exchange === 'kraken') ? m.ticker + 'USD' : null); });
    if (fwdPrior) {
      fwdFetchIds = fwdFetchList(fwdDeps, fwdPrior, pulls.map(p => p.coin.id));
      fwdFetchIds.forEach(cg => { if (!(cg in fwdPairIdOf)) fwdPairIdOf[cg] = fixed[cg] || null; });
      try { fwdInfo = await fwdFetchKrakenInfo(Array.from(new Set(fwdFetchIds.map(cg => fwdPairIdOf[cg]).filter(Boolean)))); if (fwdInfo.errors.length) console.warn('forward: Kraken info errors:', fwdInfo.errors.join('; ')); }
      catch (e) { console.warn('forward: Kraken info fetch failed:', e.message); }
      for (const cg of fwdFetchIds) {
        if (pulls.some(p => p.coin.id === cg) || !fwdPairIdOf[cg]) continue;
        try { fwdLight[cg] = await fwdLightPull(cg, fwdPairIdOf[cg], nowSec); } catch (e) { console.warn('forward: light pull failed for', cg, e.message); }
        await sleep(EXCHANGE_DELAY_MS);
      }
    }
  }
  const issueMs = Date.now();   // issueTimeUtc: read ONCE, after all fetches complete and before pipeline step 1 (Protocol §0)
  const capture = fwdMakeCapture(issueMs, crypto.randomBytes(3).toString('hex'), fwdCfg ? fwdCfg.protocolVersion : null);
  const fwdCanonicalCandidate = !!(fwdCfg && fwdStart && fwdPrior && capture.afterCanonicalGate && !fwdCfgErrors.length && !fwdAlreadyProcessed(fwdStart.current, capture));
  if (fwdCfg) console.log('forward: capture', capture.captureId, 'issue', capture.issueTimeUtc, capture.afterCanonicalGate ? '(>= 00:10 UTC)' : '(before 00:10 UTC: never canonical)', '| canonical candidate:', fwdCanonicalCandidate);

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
      // Universe rule (2026-09-25): what was rejected and why, per capture. reason in {no-exchange-listing, ticker-collision}.
      meta: { universeRule: UNIVERSE_RULE, dropped: droppedAll },
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
    const todayDate = fwdCfg ? capture.date : ymd(Date.now());
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
    // Step 11-C (Remediation spec H5, option (i)): the RESEARCH pass per coin, as an ADDITIONAL block on the daily row -
    // detectChannel(..., research:true) on the same closed-bar candles rowForDaily just used, then researchVerdict with
    // ctx = capture quote, capture-time volume24h, this run's own btcRegime, the 1d floor. Nothing above (flag-off
    // detectionDaily, the page's default verdict path) is touched; a research failure leaves research:null on the row.
    // The same rows feed the setup ledger (data/setups.json) once configHash is known, in the manifest block below.
    researchRows = [];
    let researchAct = 0, researchFits = 0;
    dailyCoins.forEach((row, i) => {
      const p = pulls[i];
      row.research = null; row.researchDaily = null;
      try {
        let candSrc = p && p.dailyCandles;
        // Forward experiment: a Kraken-designated coin's detector input is exactly the candles USABLE at issueTimeUtc with endTime <= inputCutoffUtc on its designated pair,
        // so the fit's index coordinates are the ones episodes-core.js expects (Build Spec D1 input contract).
        if (fwdCfg && p && fwdPairIdOf[p.coin.id] && exMap[p.coin.id] && exMap[p.coin.id].exchange === 'kraken') candSrc = fwdUsableCandles(p.cache.ohlcDaily, fwdCandlePair(fwdPairIdOf[p.coin.id]), capture.issueSec).filter(c => c.time + DAY_SECONDS <= capture.inputCutoffSec);
        const cands = (candSrc && candSrc.length >= 30) ? toLeanCandles(candSrc) : null;
        const candPair = (candSrc && candSrc.length) ? (candSrc[candSrc.length - 1].pair || null) : null;   // 17-H Amendment A: the stamped exchange/coingecko pair, carried on candlesRef only (LEAN_CANDLE_FIELDS never included it)
        const fit = cands ? C.detectChannel(cands, null, { coinId: row.cgId, timeframe: '1d', source: row.dailySource, research: true }) : null;
        const res = C.researchVerdict(fit, { price: row.price, volume24h: row.volume24h, btc: btcRegime, quote: null, floor: C.ACT_SCORE_FLOOR_1D });
        row.research = S.researchSummary(fit, res);
        // 17-H section 1: researchDaily = the research fit as the detector returned it (detectionDaily is the same object shape - no second field list), lean candles, written beside detectionDaily.
        // Section 1b: when the policy fit is null, the structural fallback runs on the SAME candles; its result is context only (research.fitId stays null, verdict NONE).
        // st/so hoisted out of the else block (v1.4): the SAME structural fit computed for researchDaily below is
        // reused for the forward update's continuity fallback a few lines down - no second detector call (Checkpoint
        // 7 Code section). st is populated whenever structure-core finds a winner at all, regardless of positionBand;
        // row.researchDaily (the page/log's own structural context row) still only shows it for upper/above-resistance,
        // unchanged from 17-H section 1b - only the forward-update wiring below is new.
        let so = null, st = null;
        if (fit) row.researchDaily = researchDailyOf(fit, row, null, cands, candPair);
        else {
          so = {};
          if (cands && SC) { try { st = SC.detectStructure(cands, { coinId: row.cgId, timeframe: '1d', source: row.dailySource }, so); } catch (e) { console.warn('structural fallback failed for', row.cgId, '-', e.message); } }
          if (SC) {
            const band = st ? st.positionBand : null;
            row.research.reason = !cands ? 'data-gap' : (band === 'upper' ? 'upper-channel' : (band === 'above-resistance' ? 'above-resistance' : 'no-structure'));
            if (st && !band) console.warn('structural fit with position <= 0.75 for', row.cgId, '(policy fit was null) - treated as no-structure');
            if (cands) row.research.rejections = so.rejections || null;
            if (st && band) row.researchDaily = researchDailyOf(st, row, so.rejections || null, cands, candPair);
          }
        }
        if (fwdCfg && fit && row.research && row.research.entryEconomics && fit.entryEconomics) {
          // The log row carries the levels exactly as the detector produced them (Protocol §4.1: S and T are taken as logged): zone, defended low, stop basis, target source.
          const fe = fit.entryEconomics;
          Object.assign(row.research.entryEconomics, { entryLow: fe.entryZone[0], entryHigh: fe.entryZone[1], defendedLow: fe.defendedLow, stopBasis: fe.stopBasis, targetSource: fe.targetSource });
        }
        // v1.4 §3 rule 1: when the policy fit is null, pass the structural winner (st, whatever its positionBand -
        // continuity doesn't read band) into the forward update as CONTINUITY EVIDENCE ONLY. fwdResearchRow leaves
        // `fit` null in that case, so episodes-core's screen/opening/predicates are untouched (they read `fit` only).
        if (fwdCfg && (fit || st)) {
          const pid = fwdPairIdOf[row.cgId], px = pid && fwdInfo && fwdInfo.prices[pid];
          fwdResearchByCoin[row.cgId] = fwdResearchRow(fit, res, row.research, typeof px === 'number' ? px : null, st);
        }
        if (fit) researchFits++;
        if (res.verdict === 'ACT') researchAct++;
        researchRows.push({ cgId: row.cgId, timeframe: '1d', verdict: res.verdict, lifecycleState: fit ? fit.lifecycleState : null, price: row.price,
          fit: fit ? { fitId: fit.fitId, pivotIds: fit.pivotIds || [], supSlope: fit.supSlope, supIntercept: fit.supIntercept, supportNow: fit.supportNow, invalidation: fit.invalidation, entryEconomics: fit.entryEconomics || null } : null });
      } catch (e) {
        console.warn('research pass failed for', row.cgId, '- research:null on the row:', e.message);
        researchRows.push({ cgId: row.cgId, timeframe: '1d', verdict: null, lifecycleState: null, price: row.price, fit: null });
      }
    });
    if (fwdCfg) dailyCoins.forEach(row => {   // execution context per coin: designated pair, the capture's last-trade quote with its own timestamp, tick / lot / minOrder
      const pid = fwdPairIdOf[row.cgId], inf = pid && fwdInfo && fwdInfo.assetPairs[pid], px = pid && fwdInfo && fwdInfo.prices[pid];
      row.forward = { pair: pid || null, venueEligible: !!pid, quote: typeof px === 'number' ? { price: px, fetchedAt: fwdInfo.priceFetchedAt } : null,
        metadata: inf && inf.tick && inf.lot && inf.minOrder ? { tick: inf.tick, lot: inf.lot, minOrder: inf.minOrder } : null };
    });
    console.log('research pass (11-C): fits', researchFits, 'ACT', researchAct, 'of', dailyCoins.length, 'coins; btcRegime', btcRegime ? (btcRegime.aboveEma50 ? 'above' : 'below') + ' EMA50, slope ' + (btcRegime.ema50Slope != null ? (btcRegime.ema50Slope * 100).toFixed(2) + '%' : 'n/a') : 'null');
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
      coins: dailyCoins,
      btcRegime: btcRegime,   // Step 11-A / C5: {close, ema50, ema50Slope, aboveEma50, asOf, bars} | null - see the BTC pass above
      // Gate log (2026-09-25 spec Part A): the configuration that produced each row's research.gates[], readable without the manifest.
      research: { detectorVersion: C.DETECTOR_VERSION, configHash: computeConfigHash(), floor1d: C.ACT_SCORE_FLOOR_1D }
    };
    if (fwdCfg) Object.assign(dailyPayload, { captureId: capture.captureId, issueTimeUtc: capture.issueTimeUtc, inputCutoffUtc: capture.inputCutoffUtc, protocolVersion: capture.protocolVersion, canonicalCandidate: fwdCanonicalCandidate });
    // With the forward experiment configured EVERY capture writes data/daily/<date>.<captureId>.json; the canonical capture renames its own file to <date>.json after its CURRENT rename (Protocol §2).
    const dailyDayPath = path.join(DAILY_DIR, fwdCfg ? (todayDate + '.' + capture.captureId + '.json') : (todayDate + '.json'));
    fs.mkdirSync(path.dirname(dailyDayPath), { recursive: true });
    fs.writeFileSync(dailyDayPath, JSON.stringify(dailyPayload, null, 0));
    fs.writeFileSync(path.join(DATA_DIR, 'latest-daily.json'), JSON.stringify(dailyPayload, null, 0));
    const dailyFlagged = dailyCoins.filter(c => c.detectionDaily).length;
    console.log('wrote', dailyDayPath, 'and data/latest-daily.json ->', todayDate,
      '(' + dailyFlagged + ' daily candidates)');
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
    const configHash = computeConfigHash();   // moved verbatim to a top-level function (gate log, 2026-09-25) so the daily file can carry it too
    // Step 11-C (H5): setup ledger data/setups.json - read, pure update (setups-core.js), write. Isolated so a ledger
    // failure never costs the capture files above; a missing ledger starts empty. Invariants live in setups-core.js.
    try {
      if (researchRows) {
        const setupsPath = path.join(DATA_DIR, 'setups.json');
        const prior = fs.existsSync(setupsPath) ? JSON.parse(fs.readFileSync(setupsPath, 'utf8')) : null;
        const barsByCoin = buildBarsByCoin(pulls);   // forward pipeline repair: closed bars from the freshly merged caches
        const disconnect = ledgerSilentDisconnect(prior, barsByCoin);
        if (disconnect) {
          // Guard: the ledger write (only) is aborted; the capture files above are already written and stay.
          setupsSummary = { aborted: 'silent-disconnect' };
          console.warn('LEDGER WRITE ABORTED (silent-disconnect guard): ' + disconnect + '. data/setups.json left unchanged; capture files are unaffected.');
        } else {
          const before = S.normalizeLedger(prior, barsByCoin);
          const next = S.updateSetupLedger(prior, ymd(Date.now()), researchRows, { detectorVersion: C.DETECTOR_VERSION, configHash: configHash, barsByCoin: barsByCoin });
          const openBefore = before.setups.filter(x => x.status === 'open').length, openAfter = next.setups.filter(x => x.status === 'open').length;
          const barsAdded = next.setups.reduce((a, x) => a + x.bars.length, 0) - before.setups.reduce((a, x) => a + x.bars.length, 0);
          setupsSummary = { opened: next.setups.length - before.setups.length,
            closed: next.setups.filter(x => x.status === 'closed').length - before.setups.filter(x => x.status === 'closed').length,
            open: openAfter, openBefore: openBefore, total: next.setups.length, barsAdded: barsAdded };
          fs.writeFileSync(setupsPath, JSON.stringify(next, null, 1));
          console.log('wrote data/setups.json: opened', setupsSummary.opened, 'closed', setupsSummary.closed, 'open', openAfter, 'total', next.setups.length, 'bars appended', barsAdded);
        }
      }
    } catch (e) {
      console.warn('setup ledger update failed (capture files above are unaffected):', e.message);
    }
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
        btcRegime: { ok: btcPassOk, lastClosedCandle: btcLastClosedCandle, updated: btcUpdatedThisRun, regime: btcRegime },   // Step 11-A / C5: regime = the same object written to latest-daily.json
        research: { ok: researchRows !== null, coins: researchRows ? researchRows.length : 0, setups: setupsSummary }   // Step 11-C (H5): research pass + ledger summary
      }
    };
    fs.writeFileSync(path.join(DATA_DIR, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('wrote data/capture-manifest.json');
  } catch (e) {
    console.error('CAPTURE MANIFEST WRITE FAILED (data above is unaffected and will still be committed):', e);
  }

  // ---- Forward experiment: pipeline (Protocol §4.0 steps 1-7) and the §2 commit sequence, LAST so the single push carries every file this run wrote ----
  if (fwdCfg) {
    try {
      if (!fwdCanonicalCandidate) console.log('forward: EXTRA CAPTURE — no forward update (' + (fwdCfgErrors.length ? 'configuration error' : !fwdStart ? 'startup failed' : !fwdPrior ? 'prior generation unavailable' : !capture.afterCanonicalGate ? 'issued before 00:10 UTC' : 'date already processed') + ') - data/daily/' + capture.date + '.' + capture.captureId + '.json only, no forward update');
      else {
        const coinsIn = {}, pairsNow = {};
        for (const cg of fwdFetchIds) {
          const p = pulls.find(x => x.coin.id === cg), cache = p ? p.cache : (fwdLight[cg] || null), pid = fwdPairIdOf[cg] || null, m = p ? exMap[cg] : null;
          const venueOk = !!pid && (!p || !!(m && m.exchange === 'kraken')), inf = pid && fwdInfo && fwdInfo.assetPairs[pid];
          const meta = inf && inf.tick && inf.lot && inf.minOrder ? { tick: inf.tick, lot: inf.lot, minOrder: inf.minOrder } : null;
          if (venueOk && p) pairsNow[cg] = pid;
          coinsIn[cg] = { pair: venueOk ? pid : null, venueEligible: venueOk, metadataEligible: !!meta, meta: meta,
            candles: (cache && venueOk) ? fwdUsableCandles(cache.ohlcDaily, fwdCandlePair(pid), capture.issueSec) : [], research: fwdResearchByCoin[cg] || null };
        }
        // v1.4.3 evidence loop. The pipeline is pure: it reports what it needed and did not have (submission-time Ticker snapshots for issuing orders, 5-minute bars for unresolved day-D intervals of orders AND open positions,
        // Trades for a touched straddling bar); each need is fetched ONCE (a failure leaves the interval unresolved, never assumed), then the pure pipeline is re-run on the same prior state until no new need appears.
        const fwdEv = { quotes: {}, bars5: {}, trades: {} }, fwdAttempted = new Set(), fwdErrs = (fwdInfo && fwdInfo.errors) || [];
        const fwdFetchJson = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
        const fwdNeedKey = n => [n.kind, n.cgId || '', n.pair || '', n.fromSec || '', n.toSec || ''].join('|');
        let upd = null;
        for (let iter = 0; iter < 8; iter++) {
          const needs = [];
          for (const cg of Object.keys(coinsIn)) { coinsIn[cg].bars5 = fwdEv.bars5[cg] || []; coinsIn[cg].trades = fwdEv.trades[cg] || []; }
          upd = fwdRunUpdate(fwdDeps, fwdPrior, capture, { coins: coinsIn, universeIds: pulls.map(p => p.coin.id) }, { manualDelistings: fwdReadDelistings(fwdDeps, DATA_DIR), challenger: fwdCfg.challenger, quotes: fwdEv.quotes, needs: needs });
          const todo = needs.filter(n => !fwdAttempted.has(fwdNeedKey(n))); if (!todo.length) break;
          todo.forEach(n => fwdAttempted.add(fwdNeedKey(n)));
          const tickers = Array.from(new Set(todo.filter(n => n.kind === 'ticker').map(n => n.pair)));
          if (tickers.length) {   // one request, the pairs of the orders being issued, made AFTER t_dec (issueTimeUtc was read before step 1)
            const q = await fwdFetchQuotes(fwdFetchJson, tickers, (fwdInfo && fwdInfo.assetPairs) || {}, () => Date.now());
            Object.keys(q).forEach(pr => { fwdEv.quotes[pr] = q[pr]; if (q[pr].missing) { fwdErrs.push('Ticker@issuance ' + pr + ': ' + q[pr].error); console.warn('forward: submission-time Ticker missing for', pr, '-', q[pr].error); } });
          }
          for (const n of todo.filter(n => n.kind === 'bars5')) {
            const r = await fwdFetchBars5(fwdFetchJson, n.pair, n.fromSec - FWD_BAR5);
            if (!r.ok) { fwdErrs.push('OHLC5 ' + n.pair + ': ' + r.error); console.warn('forward: 5-min OHLC failed for', n.pair, '-', r.error); continue; }
            const have = {}; (fwdEv.bars5[n.cgId] || []).forEach(b => { have[b.id] = b; }); r.bars.forEach(b => { have[b.id] = b; });
            fwdEv.bars5[n.cgId] = Object.keys(have).map(Number).sort((a, b) => a - b).map(k => have[k]);
            await sleep(EXCHANGE_DELAY_MS);
          }
          for (const n of todo.filter(n => n.kind === 'trades')) {
            const sl = await fwdFetchTradesSlice(fwdFetchJson, n.pair, n.fromSec, n.toSec, { nowSec: Math.floor(Date.now() / 1000) });
            if (!sl.complete) { fwdErrs.push('Trades ' + n.pair + ' [' + n.fromSec + ',' + n.toSec + '): ' + sl.reason); console.warn('forward: Trades incomplete for', n.pair, '-', sl.reason); }
            (fwdEv.trades[n.cgId] = fwdEv.trades[n.cgId] || []).push(sl);
            await sleep(EXCHANGE_DELAY_MS);
          }
        }
        if (fwdInfo && fwdErrs !== fwdInfo.errors) fwdInfo.errors = fwdErrs;
        const gen = { episodes: upd.episodes, orders: { schemaVersion: OC.ORDERS_SCHEMA_VERSION, orders: upd.book.orders, attempts: upd.book.attempts }, accounts: { schemaVersion: OC.ORDERS_SCHEMA_VERSION, seq: upd.book.seq, accounts: upd.book.accounts },
          scenarios: { schemaVersion: 1, label: 'counterfactual', built: false }, pairs: fwdUpdatePairs(fwdPrior.pairs, capture, pairsNow),
          episodeDays: { schemaVersion: 1, captureId: capture.captureId, date: capture.date, rows: upd.episodeDayRows } };
        const r = fwdCommitSequence(fwdDeps, DATA_DIR, capture, fwdStart.current, gen, {});
        if (r.status === 'canonical') console.log('forward: CANONICAL capture', capture.captureId, 'committed', r.sha || '(no git)', '| episodes', gen.episodes.episodes.length, 'orders', gen.orders.orders.length);
        else if (r.status === 'push-rejected') { console.error('forward: PUSH REJECTED - this run is an extra capture (no rebase, no force):', r.reason); process.exitCode = 1; }
        else console.warn('forward: EXTRA CAPTURE — no forward update (aborted: ' + r.reason + '); this run\'s own partial generation was removed');
      }
    } catch (e) {
      console.error('forward: EXTRA CAPTURE — no forward update (update failed; capture files above are unaffected):', e);
      try { const cur0 = fwdReadJson(fwdDeps, path.join(DATA_DIR, 'forward', 'CURRENT')); if (!cur0 || cur0.generationId !== capture.captureId) fwdCleanupOwn(fwdDeps, DATA_DIR, capture); } catch (e2) { /* best effort */ }
    }
  }

  console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
