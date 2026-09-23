/* radar_tools/regression-runner.js — Step 5 (Harness), Remediation spec 2026-09-22.
 * Rewritten per Ryan's "Review of Step 5 rerun": reads the gitignored local fixture snapshot
 * (radar_tools/fixtures/data/, populated by populate-fixtures.js), never live data/. Verifies
 * every fixture file's blob hash AND channel-core.stable.js's own blob hash against
 * manifest.json before running anything. Either mismatch is a HARD ABORT — there is no
 * automatic re-pin path. If fixtures/ or channel-core.stable.js have genuinely changed on
 * purpose, that is a deliberate decision someone makes by re-running populate-fixtures.js and
 * build-manifest.js themselves; this script will not paper over drift by suggesting or taking
 * that action itself.
 *
 * Runs channel-core.stable.js (pinned baseline, verified against manifest.stableDetectorBlob)
 * and channel-core.js (current, live — NOT pinned, always the repo's live file) against
 * IDENTICAL candle slices cut from the pinned fixture snapshot, for every (coin, grid-date)
 * pair it contains, and prints:
 *   - per-date score>=ACT_SCORE_FLOOR set sizes for stable vs current
 *   - score histograms for stable vs current
 *   - break runs (consecutive grid dates a coin stays in the score>=floor set) for each version
 *   - the regression-guard headline metric: stable score>=floor rows that breached their own
 *     stable-computed invalidation within 10 calendar days, cross-checked against whether
 *     current also scored >=floor on the same date (a "true positive rejection")
 *
 * KNOWN LIMITATIONS (both detectors are equally affected, so the stable-vs-current comparison
 * is fair, but this is NOT a replay of what radar.html showed historically):
 *  - Each coin's candle slice comes from the FIXTURE SNAPSHOT's cache.ohlc (pinned at
 *    fixtures/.pinned-commit), sliced up to the grid date — not a reconstruction of the
 *    365-day window the live app actually saw on that historical date.
 *  - "score>=ACT_SCORE_FLOOR" is a score-only proxy for the real ACT verdict. buildAction() in
 *    radar.html also gates on rail freshness, position, and (post-H2) gridBroken — none of
 *    which exist at the channel-core.js level. Printed columns are labeled score>=89, not ACT.
 *  - Every coin's cache.ohlc in this snapshot carries a phantom bar end-stamped 2026-09-20
 *    (Step 1 BACKLOG item). sliceToDate never selects it (no grid-date file for 2026-09-20 in
 *    this window), but it is inside the manifest's hashed set. Harmless to this run.
 *
 * Run: node regression-runner.js   (from inside radar_tools/)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const FIXTURES_DATA_DIR = path.join(FIXTURES_DIR, 'data');
const STABLE_DETECTOR_PATH = path.join(REPO_ROOT, 'channel-core.stable.js');
const ACT_SCORE_FLOOR = 89;
const HEADLINE_WINDOW_DAYS = 10;

function blobSha1(filePath) {
  const data = fs.readFileSync(filePath);
  const header = Buffer.from('blob ' + data.length + '\0');
  return crypto.createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

function verifyManifestOrAbort() {
  const manifestPath = path.join(__dirname, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('manifest.json not found. This is a hard stop, not something this script ' +
      'fixes for you: run populate-fixtures.js then build-manifest.js yourself first.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  let mismatches = 0, missing = 0;
  for (const f of manifest.files) {
    const full = path.join(FIXTURES_DIR, f.path);
    if (!fs.existsSync(full)) { missing++; console.log('FIXTURE FILE MISSING:', f.path); continue; }
    const actual = blobSha1(full);
    if (actual !== f.sha1) {
      mismatches++;
      console.log('FIXTURE DRIFT:', f.path, 'expected', f.sha1, 'got', actual);
    }
  }

  let stableMismatch = false;
  if (!fs.existsSync(STABLE_DETECTOR_PATH)) {
    console.log('STABLE DETECTOR MISSING: ../channel-core.stable.js not found.');
    stableMismatch = true;
  } else {
    const actualStableBlob = blobSha1(STABLE_DETECTOR_PATH);
    if (actualStableBlob !== manifest.stableDetectorBlob) {
      stableMismatch = true;
      console.log('STABLE DETECTOR DRIFT: manifest pins', manifest.stableDetectorBlob, 'but ../channel-core.stable.js is now', actualStableBlob);
    }
  }

  if (mismatches > 0 || missing > 0 || stableMismatch) {
    throw new Error(
      'ABORTED: pinned state does not match what is on disk (' + mismatches + ' fixture file(s) ' +
      'drifted, ' + missing + ' missing, stable-detector-mismatch=' + stableMismatch + '). ' +
      'This run is not trustworthy and will not proceed. There is no automatic re-pin — if the ' +
      'fixture snapshot or channel-core.stable.js changed on purpose, that is a deliberate call ' +
      'someone makes by re-running populate-fixtures.js and build-manifest.js themselves, not ' +
      'something this script does for you.'
    );
  }
  console.log('Manifest verified: ' + manifest.files.length + ' fixture files + stable-detector blob, 0 drift.');
  console.log('Pinned commit: ' + manifest.pinnedCommit + ' | pinned ' + manifest.generatedAt + '\n');
  return manifest;
}

function loadGridDates() {
  const gridDirs = fs.readdirSync(FIXTURES_DATA_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'cache')
    .map(e => e.name)
    .sort();
  const grids = [];
  for (const dir of gridDirs) {
    const files = fs.readdirSync(path.join(FIXTURES_DATA_DIR, dir)).filter(f => f.endsWith('.json')).sort();
    for (const f of files) {
      const g = JSON.parse(fs.readFileSync(path.join(FIXTURES_DATA_DIR, dir, f), 'utf8'));
      grids.push({ date: g.date, coins: g.coins.map(c => c.cgId) });
    }
  }
  grids.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return grids;
}

function loadCaches() {
  const cacheDir = path.join(FIXTURES_DATA_DIR, 'cache');
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const caches = {};
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
    caches[c.cgId] = (c.ohlc || []).map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, date: b.date }));
  }
  return caches;
}

// Step 7 build-review handoff (BLOCKS 1, 2026-09-22): a SEPARATE daily-candle loader,
// deliberately not folded into loadCaches() above - `caches` (ohlc, the 4-day grid array) is
// read throughout this file by every Step 5/6 section, and reshaping it to carry both series
// would ripple through code this step doesn't touch. Used only by runStep7Acceptance below,
// which is the one place '1d' actually means daily candles, not grid candles under a 1d label.
function loadDailyCaches() {
  const cacheDir = path.join(FIXTURES_DATA_DIR, 'cache');
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const caches = {};
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
    caches[c.cgId] = (c.ohlcDaily || []).map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, date: b.date }));
  }
  return caches;
}

// Step 10 D: a SEPARATE daily loader that also carries `volume` (loadDailyCaches above deliberately strips it, and
// every earlier section reads that shape). Used only by runStep10DAcceptance - volume-on-touch needs it.
function loadDailyCachesWithVolume() {
  const cacheDir = path.join(FIXTURES_DATA_DIR, 'cache');
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
  const caches = {};
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
    caches[c.cgId] = (c.ohlcDaily || []).map(b => { const o = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, date: b.date }; if (b.volume !== undefined) o.volume = b.volume; return o; });
  }
  return caches;
}

function sliceToDate(ohlc, D) {
  const idx = ohlc.findIndex(c => c.date === D);
  if (idx === -1) return null;
  return ohlc.slice(0, idx + 1);
}

// Step 8 E3/E4 remediation (restaged 2026-09-23): 1d passes are pinned to this frozen capture
// date, not the latest available daily date - dailyCaches (ohlcDaily) has been repopulated past
// this fixture snapshot's original capture since (this session, from a later pinned commit), so
// `latestDailyDate` drifts as the fixture mirror gets refreshed, breaking cross-run
// comparability of the 1d numbers (observed: it resolves to 2026-09-21, not the frozen 9/16
// capture the spec's 1d population figures were taken against). 4d-grid stays on the latest
// grid date - grid snapshots are the reproducible unit there, nothing to pin against. Shared by
// every Step 8+ acceptance section (E3 section 1, E4 section 1, and E5-E7 as they're built) so
// each doesn't reinvent its own pin.
const FROZEN_916_DATE = '2026-09-16';

function pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate) {
  const src = (tf === '1d') ? dailyCaches[cgId] : gridCaches[cgId];
  if (!src) return null;
  const D = (tf === '1d') ? FROZEN_916_DATE : latestGridDate;
  return sliceToDate(src, D);
}

function histBucket(score) {
  if (score < 40) return '<40';
  if (score < 60) return '40-59';
  if (score < 75) return '60-74';
  if (score < 89) return '75-88';
  return '89-100';
}

function daysBetween(d1, d2) {
  return Math.round((Date.parse(d2 + 'T00:00:00Z') - Date.parse(d1 + 'T00:00:00Z')) / 86400000);
}

function run() {
  verifyManifestOrAbort();

  const stable = require(STABLE_DETECTOR_PATH);
  const current = require(path.join(REPO_ROOT, 'channel-core.js'));
  const grids = loadGridDates();
  const caches = loadCaches();

  console.log('Grid dates: ' + grids.length + ' (' + grids[0].date + ' .. ' + grids[grids.length - 1].date + ')');
  console.log('Cached coins: ' + Object.keys(caches).length);
  console.log('Reading from pinned fixtures/, not live data/. See file header for limitations.\n');

  const rows = {};
  let missingSlice = 0, tooShort = { stable: 0, current: 0 };
  const histStable = {}, histCurrent = {};
  const floorSetsStable = {}, floorSetsCurrent = {};

  for (const grid of grids) {
    rows[grid.date] = [];
    floorSetsStable[grid.date] = new Set();
    floorSetsCurrent[grid.date] = new Set();
    for (const cgId of grid.coins) {
      const ohlc = caches[cgId];
      if (!ohlc) continue;
      const slice = sliceToDate(ohlc, grid.date);
      if (!slice) { missingSlice++; continue; }

      let sRes = null, cRes = null;
      try { sRes = stable.detectChannel(slice); } catch (e) { /* leave null */ }
      try { cRes = current.detectChannel(slice, undefined, { cgId, timeframe: '4d-grid', source: 'fixture' }); } catch (e) { /* leave null */ }

      const sScore = sRes ? sRes.score : null;
      const cScore = cRes ? cRes.score : null;
      if (sScore == null) tooShort.stable++;
      if (cScore == null) tooShort.current++;

      if (sScore != null) {
        histStable[histBucket(sScore)] = (histStable[histBucket(sScore)] || 0) + 1;
        if (sScore >= ACT_SCORE_FLOOR) floorSetsStable[grid.date].add(cgId);
      }
      if (cScore != null) {
        histCurrent[histBucket(cScore)] = (histCurrent[histBucket(cScore)] || 0) + 1;
        if (cScore >= ACT_SCORE_FLOOR) floorSetsCurrent[grid.date].add(cgId);
      }

      rows[grid.date].push({
        cgId, stableScore: sScore, currentScore: cScore,
        stableInvalidation: sRes ? sRes.invalidation : null
      });
    }
  }

  console.log('=== Per-date score>=' + ACT_SCORE_FLOOR + ' set sizes (NOT the real ACT verdict — see header) ===');
  console.log('date'.padEnd(12), 'stable'.padEnd(8), 'current'.padEnd(8));
  for (const grid of grids) {
    console.log(grid.date.padEnd(12), String(floorSetsStable[grid.date].size).padEnd(8), String(floorSetsCurrent[grid.date].size).padEnd(8));
  }

  console.log('\n=== Score histograms ===');
  const buckets = ['<40', '40-59', '60-74', '75-88', '89-100'];
  console.log('bucket'.padEnd(10), 'stable'.padEnd(8), 'current'.padEnd(8));
  for (const b of buckets) {
    console.log(b.padEnd(10), String(histStable[b] || 0).padEnd(8), String(histCurrent[b] || 0).padEnd(8));
  }
  console.log('\nRows evaluated: ' + Object.values(rows).reduce((a, r) => a + r.length, 0) +
    ' | missing cache slice: ' + missingSlice +
    ' | too-short-for-detection: stable=' + tooShort.stable + ' current=' + tooShort.current);

  function breakRuns(sets) {
    const active = {};
    const runs = [];
    for (const grid of grids) {
      const nowIn = sets[grid.date];
      for (const cgId of Object.keys(active)) {
        if (!nowIn.has(cgId)) {
          runs.push({ cgId, start: active[cgId].start, end: active[cgId].last, length: active[cgId].count });
          delete active[cgId];
        }
      }
      for (const cgId of nowIn) {
        if (active[cgId]) { active[cgId].last = grid.date; active[cgId].count++; }
        else active[cgId] = { start: grid.date, last: grid.date, count: 1 };
      }
    }
    for (const cgId of Object.keys(active)) {
      runs.push({ cgId, start: active[cgId].start, end: active[cgId].last, length: active[cgId].count });
    }
    return runs.sort((a, b) => b.length - a.length);
  }
  const runsStable = breakRuns(floorSetsStable);
  const runsCurrent = breakRuns(floorSetsCurrent);
  console.log('\n=== Break runs (consecutive score>=' + ACT_SCORE_FLOOR + ' grid dates) ===');
  console.log('stable: ' + runsStable.length + ' runs, longest ' + (runsStable[0] ? runsStable[0].length + ' (' + runsStable[0].cgId + ', ' + runsStable[0].start + '..' + runsStable[0].end + ')' : 'n/a'));
  console.log('current: ' + runsCurrent.length + ' runs, longest ' + (runsCurrent[0] ? runsCurrent[0].length + ' (' + runsCurrent[0].cgId + ', ' + runsCurrent[0].start + '..' + runsCurrent[0].end + ')' : 'n/a'));

  let breaches = 0, trueRejections = 0, missedByCurrent = 0;
  for (const grid of grids) {
    for (const row of rows[grid.date]) {
      if (row.stableScore == null || row.stableScore < ACT_SCORE_FLOOR || row.stableInvalidation == null) continue;
      const ohlc = caches[row.cgId];
      if (!ohlc) continue;
      let breached = false;
      for (const bar of ohlc) {
        if (bar.date <= grid.date) continue;
        const dd = daysBetween(grid.date, bar.date);
        if (dd > HEADLINE_WINDOW_DAYS) break;
        if (bar.close < row.stableInvalidation) { breached = true; break; }
      }
      if (breached) {
        breaches++;
        const currentAlsoOverFloor = floorSetsCurrent[grid.date].has(row.cgId);
        if (!currentAlsoOverFloor) { trueRejections++; }
        else { missedByCurrent++; }
      }
    }
  }
  console.log('\n=== Regression-guard headline metric ===');
  console.log('stable score>=' + ACT_SCORE_FLOOR + ' rows that breached invalidation within ' + HEADLINE_WINDOW_DAYS + ' days: ' + breaches);
  console.log('  of those, current correctly did NOT score >= floor that day (true positive rejection): ' + trueRejections);
  console.log('  of those, current ALSO scored >= floor that day (regression not caught by score alone): ' + missedByCurrent);
  if (breaches === 0) console.log('  (0 result on this sample is reported as-is — not enough score>=89 rows/window to say anything yet, not a pass/fail verdict.)');

  runResearch(current, grids, caches);
  runStep7Acceptance(current, grids, caches, loadDailyCaches());
  runStep8E3Acceptance(current, grids, caches, loadDailyCaches());
  runStep8E4Acceptance(current, grids, caches, loadDailyCaches());
  runStep8E5Acceptance(current, grids, caches, loadDailyCaches());
  runStep8E6Acceptance(current, grids, caches, loadDailyCaches());
  runStep8E7Acceptance(current, grids, caches, loadDailyCaches());
  runStep8H11Acceptance(current, grids, caches, loadDailyCaches());
  runStep9F3H3Acceptance(current, grids, caches, loadDailyCaches());
  runStep10DAcceptance(current, grids, caches, loadDailyCachesWithVolume());
  runStep11AAcceptance(current, grids, caches, loadDailyCachesWithVolume());
  runStep11BAcceptance(current, grids, caches, loadDailyCachesWithVolume());
  runStep11CAcceptance(current, grids, caches, loadDailyCachesWithVolume());
}

// Step 6 (Remediation spec, 2026-09-21/22; per Step 6 plan review 2026-09-22, §7): research
// mode is a PER-CALL flag (meta.research), not a module global (R3) — so both readings come
// from the same `current` module, called twice per row, no env var or module-reload needed.
// Prints: per-date lifecycle-state distribution (A1/H9), the railAt(...)===supportNow
// invariant (A2 index-basis decision, §5) over every research row, and the A3 touch-count
// old-flat-2.5%-vs-new-per-coin-tol comparison. `stable` has no research concept — not run.
function runResearch(current, grids, caches) {
  const LIFECYCLE_STATES = ['intact', 'wick-probed', 'broken', 'reclaimed-awaiting-retest', 're-qualified'];
  const stateCounts = {}; for (const s of LIFECYCLE_STATES) stateCounts[s] = 0;
  let researchRows = 0, researchNull = 0, invariantOk = 0, invariantBad = 0;
  let tolSum = 0, tolMin = Infinity, tolMax = -Infinity;
  const tolTable = [];
  const a5 = {}; // per-timeframe {checked, rejected}, accumulated across all rows
  // Changed-row / cause table (Step 6 build review handoff format): for every row, run BOTH
  // detectors on the identical slice and, when the winning pair differs, attribute the change
  // to the A-item responsible by matching the flag-off pair's exact (p1idx, p2idx, slope)
  // identity against research's pairLog (ground truth from the research loop itself, not a
  // guess from output fields) - see channel-core.js's pairLogEntry comment for what's logged.
  const causeCounts = {};
  const changedSample = [];
  let unchangedPair = 0, bothNull = 0;

  for (const grid of grids) {
    for (const cgId of grid.coins) {
      const ohlc = caches[cgId];
      if (!ohlc) continue;
      const slice = sliceToDate(ohlc, grid.date);
      if (!slice) continue;

      let fOff = null;
      try { fOff = current.detectChannel(slice); } catch (e) { /* leave null */ }

      const rdiag = { a5: {}, pairLog: [] };
      let rRes = null;
      try { rRes = current.detectChannel(slice, rdiag, { cgId, timeframe: '4d-grid', source: 'fixture', research: true }); } catch (e) { /* leave null */ }

      for (const tf of Object.keys(rdiag.a5)) {
        if (!a5[tf]) a5[tf] = { checked: 0, rejected: 0 };
        a5[tf].checked += rdiag.a5[tf].checked;
        a5[tf].rejected += rdiag.a5[tf].rejected;
      }

      researchRows++;
      if (!rRes) { researchNull++; }
      else {
        stateCounts[rRes.lifecycleState] = (stateCounts[rRes.lifecycleState] || 0) + 1;

        const expected = current.railAt(rRes.supSlope, rRes.supIntercept, rRes.lastIdx);
        if (Math.abs(expected - rRes.supportNow) < 1e-6) invariantOk++; else { invariantBad++; console.log('RAILAT INVARIANT FAIL', cgId, grid.date, expected, rRes.supportNow); }

        if (rRes.tol != null) {
          tolSum += rRes.tol; if (rRes.tol < tolMin) tolMin = rRes.tol; if (rRes.tol > tolMax) tolMax = rRes.tol;
          const pv = current.findPivotsWindowed(slice, current.FIT_WINDOW_GRID);
          const flatTouches = pv.lows.filter(function(l) {
            const exp = current.railAt(rRes.supSlope, rRes.supIntercept, l.idx);
            return exp > 0 && Math.abs(l.price - exp) / exp <= current.TOUCH_TOL;
          }).length;
          tolTable.push({ cgId, date: grid.date, tol: rRes.tol, touchesFlat25: flatTouches, touchesResearchTol: rRes.supportTouches });
        }
      }

      // --- changed-row cause classification ---
      if (!fOff && !rRes) { bothNull++; continue; }
      let cause;
      if (!fOff && rRes) {
        cause = 'A2/A3 (windowed+ATR-tol fit succeeds where full-history flag-off found none)';
      } else if (fOff && !rRes) {
        const pv = current.findPivotsWindowed(slice, current.FIT_WINDOW_GRID);
        if (pv.lows.length < 3 || pv.highs.length < 1) cause = 'A2 (windowed pivot set too thin)';
        else cause = 'A2/A5 (flag-off pair not reachable/rejected within the research window)';
      } else {
        const sameFirstIdx = fOff.firstIdx;
        const match = rdiag.pairLog.find(function(p) {
          return p.p1idx === sameFirstIdx && Math.abs(p.slope - fOff.supSlope) < 1e-9;
        });
        const samePair = Math.abs(fOff.supportNow - rRes.supportNow) / (Math.abs(fOff.supportNow) || 1) < 0.005;
        if (samePair) { unchangedPair++; continue; }
        if (!match) cause = 'A2 (flag-off anchor pair not present in the windowed pivot set)';
        else if (match.touches < 3) cause = 'A2/A3 (anchor pair present but touch count changed under windowed pivots/ATR tol)';
        else if (match.anchorPass === false) cause = 'A5 (anchor pair rejected by anchor-spacing)';
        else if (match.eligible === false) cause = 'A1/H9 (anchor pair ineligible under its lifecycle state - R1 marking preferred a different pair)';
        else cause = 'A2 (re-fit selects a different, legitimately higher/equal-scoring pair)';
      }
      causeCounts[cause] = (causeCounts[cause] || 0) + 1;
      if (changedSample.length < 15) {
        changedSample.push({ cgId, date: grid.date, cause,
          flagOffSupport: fOff ? fOff.supportNow.toFixed(4) : 'null',
          researchSupport: rRes ? rRes.supportNow.toFixed(4) : 'null' });
      }
    }
  }

  console.log('\n=== Research mode (Step 6, flag ON) — lifecycle states ===');
  for (const s of LIFECYCLE_STATES) console.log(s.padEnd(28), stateCounts[s]);
  console.log('research rows evaluated: ' + researchRows + ' | null: ' + researchNull);

  console.log('\n=== railAt(supSlope,supIntercept,lastIdx) === supportNow invariant (A2 index basis) ===');
  console.log('ok: ' + invariantOk + ' | FAILED: ' + invariantBad + (invariantBad === 0 ? ' (holds for every research row)' : ' — SEE FAILURES ABOVE'));

  console.log('\n=== A3 tolerance: per-coin tol range ===');
  const n = tolTable.length;
  console.log('rows with tol: ' + n + ' | min: ' + (n ? tolMin.toFixed(4) : 'n/a') + ' | max: ' + (n ? tolMax.toFixed(4) : 'n/a') + ' | mean: ' + (n ? (tolSum / n).toFixed(4) : 'n/a'));
  const outOfRange = tolTable.filter(function(r){ return r.tol < 0.01 - 1e-9 || r.tol > 0.04 + 1e-9; });
  console.log('rows with tol outside [1%,4%]: ' + outOfRange.length + (outOfRange.length ? ' — CHECK CLAMP' : ' (clamp holding)'));
  // Step 6 build-restage review (2026-09-22, population findings / A3 grid-saturation): count
  // rows sitting AT the upper clamp (TOUCH_TOL_MAX) - distinct from "out of range" above, which
  // checks the clamp is being enforced. This checks whether the clamp is doing the clamping,
  // i.e. whether ATR14-scaled tol on this (4d-grid) timeframe routinely wants to exceed 4% and
  // gets capped there - the saturation finding from the restage review.
  const atCap = tolTable.filter(function(r){ return r.tol >= current.TOUCH_TOL_MAX - 1e-9; });
  console.log('rows AT the 4% cap (saturated): ' + atCap.length + ' / ' + n +
    (n ? ' (' + (100 * atCap.length / n).toFixed(1) + '%)' : ''));
  console.log('sample rows (old flat 2.5% touches vs new per-coin-tol touches), first 15:');
  console.log('cgId'.padEnd(20), 'date'.padEnd(12), 'tol'.padEnd(8), 'touches@2.5%'.padEnd(14), 'touches@tol');
  for (const r of tolTable.slice(0, 15)) {
    console.log(r.cgId.padEnd(20), r.date.padEnd(12), r.tol.toFixed(4).padEnd(8), String(r.touchesFlat25).padEnd(14), r.touchesResearchTol);
  }

  // BLOCKS 2 (Step 6 build-restage review, 2026-09-22): "for every row" - the console sample
  // above is only 15 rows; write the FULL table to a local CSV, referenced here, not pushed.
  const csvDate = new Date().toISOString().slice(0, 10);
  const csvPath = path.join(__dirname, 'step6-a3-touch-table-' + csvDate + '.csv');
  const csvLines = ['cgId,date,tol,touchesFlat25,touchesResearchTol,atCap'];
  for (const r of tolTable) {
    csvLines.push([r.cgId, r.date, r.tol.toFixed(4), r.touchesFlat25, r.touchesResearchTol,
      r.tol >= current.TOUCH_TOL_MAX - 1e-9 ? 1 : 0].join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf8');
  console.log('\nFull A3 touch table (' + tolTable.length + ' rows) written to ' + csvPath + ' — local only, not pushed.');

  console.log('\n=== A5 anchor-spacing rejections, per timeframe ===');
  console.log('timeframe'.padEnd(14), 'checked'.padEnd(10), 'rejected');
  for (const tf of Object.keys(a5)) {
    console.log(tf.padEnd(14), String(a5[tf].checked).padEnd(10), a5[tf].rejected);
  }
  if (!Object.keys(a5).length) console.log('(no pairs reached the A5 check on this fixture)');

  console.log('\n=== Flag-off vs flag-on (research) changed-row table ===');
  console.log('Ground-truth classification via pairLog identity match (p1idx+slope), not output-field guessing.');
  console.log('both null: ' + bothNull + ' | same winning pair (unchanged, additive fields only): ' + unchangedPair +
    ' | changed pair: ' + Object.values(causeCounts).reduce((a, b) => a + b, 0));
  console.log('\nby cause:');
  for (const c of Object.keys(causeCounts).sort((a, b) => causeCounts[b] - causeCounts[a])) {
    console.log('  ' + String(causeCounts[c]).padStart(5) + '  ' + c);
  }
  console.log('\nsample changed rows, first 15:');
  console.log('cgId'.padEnd(20), 'date'.padEnd(12), 'flagOffSupport'.padEnd(16), 'researchSupport'.padEnd(16), 'cause');
  for (const r of changedSample) {
    console.log(r.cgId.padEnd(20), r.date.padEnd(12), r.flagOffSupport.padEnd(16), r.researchSupport.padEnd(16), r.cause);
  }
}

// Step 7 (Remediation spec, 2026-09-21/22; per Step 7 build review, BLOCKS 1): B1/B2/B4-B5
// acceptance, on the RIGHT data per timeframe - '1d' means dailyCaches (ohlcDaily), '4d-grid'
// means gridCaches (ohlc, the same array every other section of this file calls `caches`).
// Both are sliced to the LATEST available date in their own series (the frozen 9/21 capture
// for daily, the latest grid snapshot for grid - see the fixture note in the header), over the
// same coin universe as the latest grid snapshot, so the two timeframes are directly
// comparable per coin. Prints the spec's B1-B2/B4-B5 acceptance rows plus a B1 population
// check (pivotHighs newest-touch distribution across independent fits).
function runStep7Acceptance(current, grids, gridCaches, dailyCaches) {
  const latestGrid = grids[grids.length - 1];
  const latestGridDate = latestGrid.date;
  const coins = latestGrid.coins;

  let latestDailyDate = null;
  for (const cgId of coins) {
    const d = dailyCaches[cgId];
    if (!d || !d.length) continue;
    const last = d[d.length - 1].date;
    if (!latestDailyDate || last > latestDailyDate) latestDailyDate = last;
  }

  console.log('\n=== Step 7 acceptance (B1, B2, B4-B5) — 1d on ohlcDaily, 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' | latest daily date: ' + latestDailyDate + ' | coin universe: ' + coins.length);

  function runOne(cgId, tf) {
    const src = (tf === '1d') ? dailyCaches[cgId] : gridCaches[cgId];
    if (!src) return null;
    const D = (tf === '1d') ? latestDailyDate : latestGridDate;
    const slice = sliceToDate(src, D);
    if (!slice) return null;
    let r = null;
    try { r = current.detectChannel(slice, undefined, { cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
    return r ? { r: r, price: slice[slice.length - 1].close } : null;
  }

  console.log('\n--- B4-B5 gate: distToRailPct <= min(2*tol, 0.06), both timeframes, full coin universe ---');
  console.log('cgId'.padEnd(28), 'tf'.padEnd(8), 'fit'.padEnd(11), 'state'.padEnd(24), 'distToRailPct'.padEnd(14), 'gate'.padEnd(8), 'verdict');
  let gateChecked = 0, gateFail = 0;
  for (const tf of ['1d', '4d-grid']) {
    for (const cgId of coins) {
      const out = runOne(cgId, tf);
      if (!out) continue;
      const r = out.r;
      const gate = Math.min(2 * r.tol, 0.06);
      const fails = r.distToRailPct > gate;
      gateChecked++; if (fails) gateFail++;
      console.log(cgId.padEnd(28), tf.padEnd(8), r.resistanceFit.padEnd(11), r.lifecycleState.padEnd(24),
        (r.distToRailPct * 100).toFixed(1).padStart(6) + '%', (gate * 100).toFixed(2).padStart(6) + '%',
        fails ? 'FAILS-GATE' : 'passes');
    }
  }
  console.log('gate checked: ' + gateChecked + ' rows | fails: ' + gateFail + ' (' + (gateChecked ? (100 * gateFail / gateChecked).toFixed(1) : '0') + '%)');

  console.log('\n--- Named-coin spot-check (spec B1-B2/B4-B5 table) ---');
  const named = { XRP: 'ripple', XLM: 'stellar', CC: 'crypto-com-chain', SKY: 'sky', JTO: 'jito-governance-token', KITE: 'kite-2', TRX: 'tron' };
  for (const label of Object.keys(named)) {
    const cgId = named[label];
    for (const tf of ['1d', '4d-grid']) {
      const out = runOne(cgId, tf);
      if (!out) { console.log(label + ' (' + cgId + ') ' + tf + ' - no research fit'); continue; }
      const r = out.r;
      const gate = Math.min(2 * r.tol, 0.06);
      console.log(label + ' (' + cgId + ') ' + tf + ': fit=' + r.resistanceFit + ' state=' + r.lifecycleState +
        ' distToRailPct=' + (r.distToRailPct * 100).toFixed(1) + '% gate=' + (gate * 100).toFixed(1) + '%' +
        (r.distToRailPct > gate ? ' FAIL' : ' pass') + ' position=' + r.position.toFixed(3));
    }
  }

  console.log('\n--- B1 population: resistanceFit distribution + newest pivotHighs date, independent fits ---');
  for (const tf of ['1d', '4d-grid']) {
    let independent = 0, parallel = 0;
    const newestDates = [];
    for (const cgId of coins) {
      const out = runOne(cgId, tf);
      if (!out) continue;
      if (out.r.resistanceFit === 'independent') {
        independent++;
        if (out.r.pivotHighs.length) newestDates.push(out.r.pivotHighs.map(function(h){return h.time;}).sort().slice(-1)[0]);
      } else if (out.r.resistanceFit === 'parallel') {
        parallel++;
      }
    }
    console.log(tf + ': ' + independent + ' independent fits, ' + parallel + ' parallel fallbacks.');
  }
}


// Step 8 E3 (Remediation spec, 2026-09-21/22; restage 2026-09-23; runner fix 2026-09-23 -
// see RADAR STATE handoff: the original build read OLD off a local channel-core.orig.js
// snapshot that was never pushed, which threw MODULE_NOT_FOUND and broke run() on main).
// Two comparisons, both over the SAME frozen coin universe/dates runStep7Acceptance already
// establishes (latest grid date for 4d-grid, latest daily date - the frozen 9/16 capture in
// this fixture snapshot - for 1d):
//   1. OLD vs NEW bullEngulf field under research mode, per pass - the actual before/after E3
//      makes. OLD is bullEngulfing(candles) called directly on `current` - a pure function of
//      the candles, unchanged since before E3 and still exported unmodified, which is exactly
//      what research-mode bullEngulf read before bullEngulfingResearch existed, so no second
//      module is needed to reconstruct it. Every row that changes is listed and labeled E3
//      (this is the only spec item touching bullEngulf, so there is nothing else it could be
//      attributed to).
//   2. Flag-off vs research bullEngulf under NEW alone, 1d pass only - the population-delta
//      observation the plan asked for, not a target to tune toward.
function runStep8E3Acceptance(current, grids, gridCaches, dailyCaches) {
  const latestGrid = grids[grids.length - 1];
  const latestGridDate = latestGrid.date;
  const coins = latestGrid.coins;

  console.log('\n=== Step 8 E3 acceptance (bullEngulfingResearch tightening) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }

  console.log('\n--- 1. OLD vs NEW bullEngulf (research mode), per pass — every changed row attributed to E3 ---');
  for (const tf of ['1d', '4d-grid']) {
    let oldTrue = 0, newTrue = 0, checked = 0;
    const changed = [];
    for (const cgId of coins) {
      const s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      let newR = null;
      try { newR = current.detectChannel(s, undefined, { cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      // Step 8 E3 fix (2026-09-23): OLD is read straight off `current.bullEngulfing` (the
      // pure, unchanged base function) rather than a second module - see the header comment
      // above runStep8E3Acceptance for why. Gated on newR existing, same scope the
      // orig/current pairing always had: fit existence itself is untouched by any bullEngulf
      // change (structural pair-selection gates don't depend on the pattern flags), so this
      // reproduces the identical checked/changed set the two-module version produced.
      const oldHit = !!(newR && current.bullEngulfing(s).hit);
      const newHit = !!(newR && newR.bullEngulf);
      checked++;
      if (oldHit) oldTrue++;
      if (newHit) newTrue++;
      if (oldHit !== newHit) changed.push({ cgId: cgId, oldHit: oldHit, newHit: newHit });
    }
    console.log(tf + ': checked ' + checked + ' | OLD bullEngulf true: ' + oldTrue + ' | NEW bullEngulf true: ' + newTrue +
      ' | changed rows: ' + changed.length);
    for (const c of changed) {
      console.log('    ' + c.cgId.padEnd(28) + ' ' + (c.oldHit ? 'true' : 'false') + ' -> ' + (c.newHit ? 'true' : 'false') +
        '  (E3: bullEngulfingResearch tightening)');
    }
  }

  console.log('\n--- 2. Population-delta OBSERVATION (not a target): flag-off vs research bullEngulf under NEW, 1d pass, frozen 9/16 capture ---');
  // Pinned to the literal 2026-09-16 date, NOT latestDailyDate above - dailyCaches (ohlcDaily)
  // extends past 9/16 in this fixture snapshot (repopulated this session from a later pinned
  // commit), so latestDailyDate resolves to 2026-09-21, not the frozen 9/16 capture Ryan asked
  // for. Uses the shared module-level FROZEN_916_DATE (section 1 above now pins its own 1d
  // slice to the same constant, via pinnedSlice) - no local re-declaration here, since a local
  // const of the same name would shadow the module-level one for this function's ENTIRE body
  // (TDZ applies from the top of the enclosing scope, not just after the declaration line) and
  // break section 1's earlier reference to it above.
  let flagOffTrue = 0, researchTrue = 0, checked1d = 0, missing916 = 0;
  for (const cgId of coins) {
    const src = dailyCaches[cgId];
    const s = src ? sliceToDate(src, FROZEN_916_DATE) : null;
    if (!s) { missing916++; continue; }
    if (s.length < 30) continue;
    let flagOffR = null, researchR = null;
    try { flagOffR = current.detectChannel(s, undefined, { cgId, timeframe: '1d', source: 'fixture' }); } catch (e) { /* null */ }
    try { researchR = current.detectChannel(s, undefined, { cgId, timeframe: '1d', source: 'fixture', research: true }); } catch (e) { /* null */ }
    checked1d++;
    if (flagOffR && flagOffR.bullEngulf) flagOffTrue++;
    if (researchR && researchR.bullEngulf) researchTrue++;
  }
  console.log('1d, frozen ' + FROZEN_916_DATE + ' capture universe: checked ' + checked1d + ' (missing/short: ' + missing916 +
    ') | flag-off bullEngulf true: ' + flagOffTrue + ' | research (post-E3) bullEngulf true: ' + researchTrue);
}


// Step 8 E4 (Remediation spec, 2026-09-21/22; restaged 2026-09-23 per review): rocketAtSupportResearch.
// OLD = current.rocketAtSupport(candles, ...) called DIRECTLY ON THE RESEARCH WINNER's own rail
// (newR.supSlope/newR.supIntercept) - never a snapshot file, and never a separate flag-off
// detectChannel() call with its own, possibly-different winning rail. This isolates the E4
// diff completely: OLD and NEW are always evaluated against the identical rail and candle: the
// only thing that can differ is which function computed the boolean. Row set = rows with a
// research fit (no fit, no rail to test OLD against either).
//
// Attribution walks the same six gates in the same order rocketAtSupportResearch itself
// short-circuits: near-rail, wick-body, wick-ATR, close-tol, lifecycle, prior-5. near-rail is
// the ONE gate whose definition actually differs between the two functions (OLD: body low +
// flat TOUCH_TOL; NEW: wick low + the research fit's own per-coin tol) - every other NEW gate
// is a pure ADDITION with no OLD counterpart, so it can only turn a hit OFF, never on. That
// means a false->true flip can only ever be explained by near-rail (OLD's test failed where
// NEW's, different by definition, passed) - anything else attributed to a false->true flip
// would be a bug, checked below rather than assumed.
function classifyE4(current, s, newR) {
  const i = s.length - 1, c = s[i];
  const bodyLow = Math.min(c.open, c.close);
  const railVal = current.railAt(newR.supSlope, newR.supIntercept, i);
  const nearRailOld = railVal > 0 && Math.abs(bodyLow - railVal) / railVal <= current.TOUCH_TOL;
  const nearRailNew = railVal > 0 && Math.abs(c.low - railVal) / railVal <= newR.tol;
  if (nearRailOld !== nearRailNew) return 'near-rail';

  const lowerWick = bodyLow - c.low;
  const body = Math.abs(c.close - c.open);
  if (!(lowerWick >= current.ROCKET_WICK_BODY * body)) return 'wick-body';
  if (!(newR.atr14 != null && lowerWick >= current.ROCKET_WICK_ATR * newR.atr14)) return 'wick-ATR';

  const range = c.high - c.low;
  if (!(range > 0 && (c.high - c.close) <= current.ROCKET_CLOSE_TOL * range)) return 'close-tol';

  if (!(newR.lifecycleState === 'intact' || newR.lifecycleState === 're-qualified')) return 'lifecycle';

  let allPriorBelow = true;
  for (let k = 1; k <= current.ROCKET_PRIOR_CLOSES_BELOW; k++) {
    const pi = i - k;
    if (pi < 0) { allPriorBelow = false; break; }
    const pRail = current.railAt(newR.supSlope, newR.supIntercept, pi);
    if (!(pRail > 0) || !(s[pi].close < pRail)) { allPriorBelow = false; break; }
  }
  if (allPriorBelow) return 'prior-5';

  return 'unattributed';
}

function runStep8E4Acceptance(current, grids, gridCaches, dailyCaches) {
  const latestGrid = grids[grids.length - 1];
  const latestGridDate = latestGrid.date;
  const coins = latestGrid.coins;

  console.log('\n=== Step 8 E4 acceptance (rocketAtSupportResearch) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }

  console.log('\n--- 1. rocket: OLD (rocketAtSupport on the research winner\'s own rail) vs NEW (research fit .rocket), per pass — every changed row attributed to a cause ---');
  let flipUpTotal = 0, flipDownTotal = 0, badFlipUp = 0;
  let lifecycleViolations = 0;
  // Gate funnel (population measurement, not per-coin): where research rows fall out of
  // rocketAtSupportResearch's gate chain, in the same order the function short-circuits.
  const funnel = { rows: 0, fit: 0, greenValid: 0, nearRailWick: 0, wickBody: 0, wickAtr: 0, closeTol: 0, lifecycle: 0, prior5: 0, hit: 0 };
  for (const tf of ['1d', '4d-grid']) {
    let oldTrue = 0, newTrue = 0, checked = 0;
    const changed = [];
    for (const cgId of coins) {
      const s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      funnel.rows++;
      let newR = null;
      try { newR = current.detectChannel(s, undefined, { cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      if (!newR) continue; // row set = rows with a research fit
      funnel.fit++;

      // Invariant: no research rocket on a rail that isn't intact/re-qualified.
      if (newR.rocket && !(newR.lifecycleState === 'intact' || newR.lifecycleState === 're-qualified')) {
        lifecycleViolations++;
        console.log('RESEARCH ROCKET ON INELIGIBLE RAIL', cgId, tf, newR.lifecycleState);
      }

      const i = s.length - 1, c = s[i];
      if (c.close > c.open && (c.high - c.low) > 0) {
        funnel.greenValid++;
        const bodyLow = Math.min(c.open, c.close);
        const railVal = current.railAt(newR.supSlope, newR.supIntercept, i);
        if (railVal > 0 && Math.abs(c.low - railVal) / railVal <= newR.tol) {
          funnel.nearRailWick++;
          const lowerWick = bodyLow - c.low;
          const body = Math.abs(c.close - c.open);
          if (lowerWick >= current.ROCKET_WICK_BODY * body) {
            funnel.wickBody++;
            if (newR.atr14 != null && lowerWick >= current.ROCKET_WICK_ATR * newR.atr14) {
              funnel.wickAtr++;
              const range = c.high - c.low;
              if ((c.high - c.close) <= current.ROCKET_CLOSE_TOL * range) {
                funnel.closeTol++;
                if (newR.lifecycleState === 'intact' || newR.lifecycleState === 're-qualified') {
                  funnel.lifecycle++;
                  let allBelow = true;
                  for (let k = 1; k <= current.ROCKET_PRIOR_CLOSES_BELOW; k++) {
                    const pi = i - k;
                    if (pi < 0) { allBelow = false; break; }
                    const pr = current.railAt(newR.supSlope, newR.supIntercept, pi);
                    if (!(pr > 0) || !(s[pi].close < pr)) { allBelow = false; break; }
                  }
                  if (!allBelow) { funnel.prior5++; funnel.hit++; }
                }
              }
            }
          }
        }
      }

      const oldHit = current.rocketAtSupport(s, newR.supSlope, newR.supIntercept).hit;
      const newHit = !!newR.rocket;
      checked++;
      if (oldHit) oldTrue++;
      if (newHit) newTrue++;
      if (oldHit !== newHit) {
        const cause = classifyE4(current, s, newR);
        changed.push({ cgId: cgId, oldHit: oldHit, newHit: newHit, cause: cause });
        if (!oldHit && newHit) {
          flipUpTotal++;
          if (cause !== 'near-rail') badFlipUp++;
        } else {
          flipDownTotal++;
        }
      }
    }
    console.log(tf + ': checked ' + checked + ' (rows with a research fit) | OLD rocket true: ' + oldTrue +
      ' | NEW rocket true: ' + newTrue + ' | changed rows: ' + changed.length);
    for (const c of changed) {
      console.log('    ' + c.cgId.padEnd(28) + ' ' + (c.oldHit ? 'true' : 'false') + ' -> ' + (c.newHit ? 'true' : 'false') +
        '  (E4: ' + c.cause + ')');
    }
  }

  console.log('\n--- 2. Gate funnel (both passes combined) — where rows fall out, in short-circuit order ---');
  console.log('rows checked: ' + funnel.rows + ' | research fit exists: ' + funnel.fit +
    ' | green/valid-range candle: ' + funnel.greenValid + ' | near rail (wick anchor, within tol): ' + funnel.nearRailWick);
  console.log('wick-body floor (>=' + current.ROCKET_WICK_BODY + 'x body): ' + funnel.wickBody +
    ' | wick-ATR floor (>=' + current.ROCKET_WICK_ATR + 'x ATR14): ' + funnel.wickAtr +
    ' | close-tol: ' + funnel.closeTol + ' | lifecycle (intact/re-qualified): ' + funnel.lifecycle +
    ' | prior-5 (not all below): ' + funnel.prior5 + ' | HIT: ' + funnel.hit);

  console.log('\n--- 3. E4 invariants (see radar_tools/step8-e4-invariant-tests.js, local only, for the full 2162-row versions) ---');
  console.log('research rocket fired on an ineligible (non intact/re-qualified) rail: ' + lifecycleViolations +
    (lifecycleViolations === 0 ? ' (none - gate holding)' : ' — VIOLATIONS, SEE ABOVE'));
  console.log('false->true flips: ' + flipUpTotal + ' total, ' + badFlipUp + ' NOT attributed to the near-rail anchor class' +
    (badFlipUp === 0 ? ' (every false->true flip is the legitimate anchor class)' : ' — UNEXPECTED, SEE ROWS ABOVE'));
  console.log('true->false flips: ' + flipDownTotal);
  console.log('total changed rows (both passes): ' + (flipUpTotal + flipDownTotal) +
    (flipUpTotal + flipDownTotal >= 1 ? ' (at least one flip - not a no-op build)' : ' — ZERO FLIPS, unexpected for a tightened/re-anchored gate'));
}


// Step 8 E5 (Remediation spec, 2026-09-21/22; restaged 2026-09-23): threeInsideUpResearch.
// OLD = current.threeInsideUp(slice).hit, computed DIRECTLY ON THE RESEARCH WINNER'S OWN
// SLICE (same "compute OLD on the research fit's own row" pattern as E3/E4's runner sections,
// so OLD and NEW are always evaluated against the identical candle set - only the function
// differs). Row set = rows with a research fit (same convention as E3/E4 - no fit, nothing to
// compare NEW against either).
//
// threeInsideUpResearch is threeInsideUp's own four conditions AND one more (c3.close >
// c1.open) - a strict tightening, not a re-anchor like E4's near-rail switch. That means NEW
// can only ever be a SUBSET of OLD: every possible flip is true->false, and a false->true flip
// would be a bug in either function, checked directly below rather than assumed impossible.
function classifyE5(s) {
  var n = s.length, c1 = s[n - 3], c3 = s[n - 1];
  if (!(c3.close > c1.open)) return 'c3-not-above-c1-open';
  return 'unattributed';
}

function runStep8E5Acceptance(current, grids, gridCaches, dailyCaches) {
  var latestGrid = grids[grids.length - 1];
  var latestGridDate = latestGrid.date;
  var coins = latestGrid.coins;

  console.log('\n=== Step 8 E5 acceptance (threeInsideUpResearch) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }

  console.log('\n--- 1. threeInsideUp: OLD (current.threeInsideUp on the research winner\'s own slice) vs NEW (research fit .threeInsideUp), per pass — every changed row attributed ---');
  var flipUpTotal = 0, flipDownTotal = 0, badFlipUp = 0, unattributed = 0;
  for (var ti = 0; ti < 2; ti++) {
    var tf = ['1d', '4d-grid'][ti];
    var oldTrue = 0, newTrue = 0, checked = 0;
    var changed = [];
    for (var ci = 0; ci < coins.length; ci++) {
      var cgId = coins[ci];
      var s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      var newR = null;
      try { newR = current.detectChannel(s, undefined, { cgId: cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      if (!newR) continue; // row set = rows with a research fit
      var oldHit = current.threeInsideUp(s).hit;
      var newHit = !!newR.threeInsideUp;
      checked++;
      if (oldHit) oldTrue++;
      if (newHit) newTrue++;
      if (oldHit !== newHit) {
        var cause = classifyE5(s);
        if (cause === 'unattributed') unattributed++;
        changed.push({ cgId: cgId, oldHit: oldHit, newHit: newHit, cause: cause });
        if (!oldHit && newHit) { flipUpTotal++; badFlipUp++; } // structurally impossible — see header
        else { flipDownTotal++; }
      }
    }
    console.log(tf + ': checked ' + checked + ' (rows with a research fit) | OLD threeInsideUp true: ' + oldTrue +
      ' | NEW threeInsideUp true: ' + newTrue + ' | changed rows: ' + changed.length);
    for (var k = 0; k < changed.length; k++) {
      var c = changed[k];
      console.log('    ' + c.cgId.padEnd(28) + ' ' + (c.oldHit ? 'true' : 'false') + ' -> ' + (c.newHit ? 'true' : 'false') +
        '  (E5: ' + c.cause + ')');
    }
  }

  console.log('\n--- 2. E5 invariants (see radar_tools/step8-e5-invariant-tests.js, local only, for the full 2162-row versions) ---');
  console.log('false->true flips: ' + flipUpTotal + ' total, ' + badFlipUp + ' NOT structurally attributable' +
    (badFlipUp === 0 ? ' (none — threeInsideUpResearch is a strict tightening of threeInsideUp, a false->true flip is structurally impossible)' : ' — UNEXPECTED, SEE ROWS ABOVE, THIS IS A BUG'));
  console.log('true->false flips: ' + flipDownTotal);
  console.log('total changed rows (both passes): ' + (flipUpTotal + flipDownTotal) +
    (flipUpTotal + flipDownTotal >= 1 ? ' (at least one flip - not a no-op build)' : ' — ZERO FLIPS, unexpected for a tightened gate'));
  console.log('every changed row attributed (no \'unattributed\'): ' + unattributed +
    (unattributed === 0 ? ' (holds)' : ' — SEE ABOVE'));
}


// Step 8 E6 (Remediation spec, 2026-09-21/22): conflict rule. OLD = research fit with the
// conflict check ignored — pre-E6, `conflictingSignals` doesn't exist and patternBonus is
// always applied when patternN>0. NEW = research fit with the conflict check applied — E6's
// own live behavior (conflictingSignals set, patternBonus excluded when it is). Both read
// straight off the SAME research winner (newR), same "compute OLD on the research fit's own
// row" pattern as E3-E5's runner sections. conf.bb3/bullEngulf/threeInsideUp are candle-level
// and untouched by E6 (see channel-core.js's E6 comments), so patternN — and therefore OLD's
// patternBonus — is reproduced exactly from newR's own stored bb3/bullEngulf/threeInsideUp
// fields (E3-E5 outputs, unaffected here), no second module or snapshot file needed. Row set
// = rows with a research fit (same convention as E3-E5 — no fit, nothing to compare NEW
// against either).
//
// conflictingSignals can only ever flip false->true: OLD never had the field (equivalent to
// always false), so every changed row is a false->true flip by construction — a true->false
// flip would mean NEW's field went missing or reverted, which nothing in E6 does, checked
// directly below rather than assumed.
function bullishTriggerName(trigger, newR) {
  if (trigger === newR.bullEngulfTrigger) return 'bullEngulf';
  if (trigger === newR.threeInsideUpTrigger) return 'threeInsideUp';
  if (trigger === newR.rocketTrigger) return 'rocket';
  return 'unknown-bullish';
}
function bearishTriggerName(trigger, newR) {
  if (trigger === newR.bb3UpperReversionTrigger) return 'bb3UpperReversion';
  if (trigger === newR.threeInsideDownTrigger) return 'threeInsideDown';
  return 'unknown-bearish';
}

function runStep8E6Acceptance(current, grids, gridCaches, dailyCaches) {
  var latestGrid = grids[grids.length - 1];
  var latestGridDate = latestGrid.date;
  var coins = latestGrid.coins;

  console.log('\n=== Step 8 E6 acceptance (conflict rule) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }

  console.log('\n--- 1. conflictingSignals: OLD (conflict ignored) vs NEW (conflict applied), per pass — every changed row attributed to its conflicting pair ---');
  var flipUpTotal = 0, flipDownTotal = 0, badFlipDown = 0, unattributed = 0;
  var pairCounts = {};
  for (var ti = 0; ti < 2; ti++) {
    var tf = ['1d', '4d-grid'][ti];
    var oldTrue = 0, newTrue = 0, checked = 0, bonusExcludedSum = 0;
    var changed = [];
    for (var ci = 0; ci < coins.length; ci++) {
      var cgId = coins[ci];
      var s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      var newR = null;
      try { newR = current.detectChannel(s, undefined, { cgId: cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      if (!newR) continue; // row set = rows with a research fit
      checked++;

      var patternN = (newR.bb3 ? 1 : 0) + (newR.bullEngulf ? 1 : 0) + (newR.threeInsideUp ? 1 : 0);
      var oldPatternBonus = patternN > 0 ? (2 * patternN - 1) : 0;
      var oldHit = false; // OLD structurally always false — see header
      var newHit = !!newR.conflictingSignals;
      if (oldHit) oldTrue++;
      if (newHit) newTrue++;

      if (oldHit !== newHit) {
        var pair = newR.conflictingSignalsPair;
        var cause = pair ? (bullishTriggerName(pair.bullish, newR) + ' vs ' + bearishTriggerName(pair.bearish, newR)) : 'unattributed';
        if (cause === 'unattributed' || cause.indexOf('unknown') !== -1) unattributed++;
        pairCounts[cause] = (pairCounts[cause] || 0) + 1;
        var newPatternBonus = newHit ? 0 : oldPatternBonus;
        changed.push({ cgId: cgId, oldHit: oldHit, newHit: newHit, cause: cause, oldPatternBonus: oldPatternBonus, newPatternBonus: newPatternBonus });
        if (!oldHit && newHit) { flipUpTotal++; bonusExcludedSum += (oldPatternBonus - newPatternBonus); }
        else { flipDownTotal++; badFlipDown++; } // structurally impossible — see header, this is a bug if it happens
      }
    }
    console.log(tf + ': checked ' + checked + ' (rows with a research fit) | OLD conflictingSignals true: ' + oldTrue +
      ' | NEW conflictingSignals true: ' + newTrue + ' | changed rows: ' + changed.length +
      ' | total patternBonus excluded this pass: ' + bonusExcludedSum);
    for (var k = 0; k < changed.length; k++) {
      var c = changed[k];
      console.log('    ' + c.cgId.padEnd(28) + ' ' + c.oldHit + ' -> ' + c.newHit +
        '  (E6: ' + c.cause + ', patternBonus ' + c.oldPatternBonus + ' -> ' + c.newPatternBonus + ')');
    }
  }

  console.log('\n--- 2. E6 invariants (see radar_tools/step8-e6-invariant-tests.js, local only, for the full 2162-row versions) ---');
  console.log('false->true flips: ' + flipUpTotal + ' total');
  console.log('true->false flips: ' + flipDownTotal + ', ' + badFlipDown + ' NOT structurally attributable' +
    (badFlipDown === 0 ? ' (none — conflictingSignals is a new field, OLD is structurally always false, a true->false flip is structurally impossible)' : ' — UNEXPECTED, SEE ROWS ABOVE, THIS IS A BUG'));
  console.log('total changed rows (both passes): ' + (flipUpTotal + flipDownTotal) +
    (flipUpTotal + flipDownTotal >= 1 ? ' (at least one flip - not a no-op build)' : ' — ZERO FLIPS, unexpected for a new gate'));
  console.log('every changed row attributed to a named conflicting pair (no \'unattributed\'/\'unknown\'): ' + unattributed +
    (unattributed === 0 ? ' (holds)' : ' — SEE ABOVE'));
  console.log('\nconflicting pairs by population (both passes combined):');
  for (var pc of Object.keys(pairCounts).sort(function(a, b){ return pairCounts[b] - pairCounts[a]; })) {
    console.log('  ' + String(pairCounts[pc]).padStart(5) + '  ' + pc);
  }
  if (!Object.keys(pairCounts).length) console.log('  (no conflicting rows on this fixture)');
}


// Step 8 E7 (Remediation spec, 2026-09-21/22): multi-signal input trace. TRACE, not a build —
// detectChannelResearch's own multiSignalOnOneCandle call (channel-core.js, right after the
// research winner/rocket are known) was ALREADY fed the research-floored triggers before this
// item was opened: conf.bullEngulf = bullEngulfingResearch(...) (E3), conf.threeInsideUp =
// threeInsideUpResearch(...) (E5), rocket = rocketAtSupportResearch(...) (E4). bb3Coincidence
// has no research variant (bb3Reversion is unchanged by every E-item) so it is identical on
// both sides by construction. Traced directly against the pushed source on 2026-09-23 — not
// inferred from field names, comments, or the E3-E6 diffs alone. Confirmed: E7 needs NO
// detector code change. channel-core.js is untouched by this item.
//
// This section is OLD (multiSignalOnOneCandle called on the BASE/unfloored triggers —
// bullEngulfing/threeInsideUp/rocketAtSupport — computed DIRECTLY on the research winner's own
// slice/rail, same "compute OLD on the research fit's own row" pattern as E3-E6) vs NEW
// (newR.multiSignal, E6's existing live field — this item changes nothing about how it's
// computed). Row set = rows with a research fit (same convention as E3-E6).
//
// All four trigger functions fed into multiSignalOnOneCandle at this call site report idx=n-1
// on every hit — bullEngulfing/bullEngulfingResearch, threeInsideUp/threeInsideUpResearch,
// rocketAtSupport/rocketAtSupportResearch all evaluate only the trailing candle (verified by
// reading each function's return statement); bb3Coincidence is deliberately forced to idx=n-1
// by detectChannelResearch itself (see its own inline comment). So multiSignalOnOneCandle's
// |idx delta|<=1 adjacency test is always satisfied between any two hits at this call site —
// the call reduces to "at least 2 of these 4 booleans true". That means every OLD-vs-NEW flip
// is fully explained by which of bullEngulf/threeInsideUp/rocket changed individually between
// its base and research-floored form (checked directly below, not assumed) — bb3 never differs.
function bb3CoincidenceOf(newR, s) {
  return newR.bb3 ? { hit: true, idx: s.length - 1, time: s[s.length - 1].time } : newR.bb3Trigger;
}

function runStep8E7Acceptance(current, grids, gridCaches, dailyCaches) {
  var latestGrid = grids[grids.length - 1];
  var latestGridDate = latestGrid.date;
  var coins = latestGrid.coins;

  console.log('\n=== Step 8 E7 acceptance (multi-signal input trace — no detector code change) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }

  console.log('\n--- 1. multiSignal: OLD (multiSignalOnOneCandle on base/unfloored triggers, same research winner\'s slice/rail) vs NEW (research fit .multiSignal), per pass — every changed row attributed ---');
  var flipUpTotal = 0, flipDownTotal = 0, unattributed = 0;
  for (var ti = 0; ti < 2; ti++) {
    var tf = ['1d', '4d-grid'][ti];
    var oldTrue = 0, newTrue = 0, checked = 0;
    var changed = [];
    for (var ci = 0; ci < coins.length; ci++) {
      var cgId = coins[ci];
      var s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      var newR = null;
      try { newR = current.detectChannel(s, undefined, { cgId: cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      if (!newR) continue; // row set = rows with a research fit
      checked++;

      var bb3C = bb3CoincidenceOf(newR, s);
      var bullEngulfOld = current.bullEngulfing(s);
      var threeInsideUpOld = current.threeInsideUp(s);
      var rocketOld = current.rocketAtSupport(s, newR.supSlope, newR.supIntercept);
      var oldMulti = current.multiSignalOnOneCandle([bb3C, bullEngulfOld, threeInsideUpOld, rocketOld]);

      var oldHit = !!oldMulti.hit;
      var newHit = !!newR.multiSignal;
      if (oldHit) oldTrue++;
      if (newHit) newTrue++;

      if (oldHit !== newHit) {
        var causes = [];
        if (bullEngulfOld.hit !== newR.bullEngulf) causes.push('E3(bullEngulf ' + bullEngulfOld.hit + '->' + newR.bullEngulf + ')');
        if (threeInsideUpOld.hit !== newR.threeInsideUp) causes.push('E5(threeInsideUp ' + threeInsideUpOld.hit + '->' + newR.threeInsideUp + ')');
        if (rocketOld.hit !== newR.rocket) causes.push('E4(rocket ' + rocketOld.hit + '->' + newR.rocket + ')');
        var cause = causes.length ? causes.join(', ') : 'unattributed';
        if (!causes.length) unattributed++;
        changed.push({ cgId: cgId, oldHit: oldHit, newHit: newHit, cause: cause });
        if (!oldHit && newHit) flipUpTotal++; else flipDownTotal++;
      }
    }
    console.log(tf + ': checked ' + checked + ' (rows with a research fit) | OLD multiSignal true: ' + oldTrue +
      ' | NEW multiSignal true: ' + newTrue + ' | changed rows: ' + changed.length);
    for (var k = 0; k < changed.length; k++) {
      var c = changed[k];
      console.log('    ' + c.cgId.padEnd(28) + ' ' + c.oldHit + ' -> ' + c.newHit + '  (' + c.cause + ')');
    }
  }

  console.log('\n--- 2. E7 invariants (see radar_tools/step8-e7-invariant-tests.js, local only, for the full 2162-row versions) ---');
  console.log('false->true flips: ' + flipUpTotal + ' | true->false flips: ' + flipDownTotal +
    ' | total changed rows (both passes): ' + (flipUpTotal + flipDownTotal) +
    (flipUpTotal + flipDownTotal >= 1 ? ' (at least one flip - confirms the E3-E5 floors do reach multiSignal, not a no-op trace)' :
      ' — ZERO FLIPS, unexpected given E3-E5 changed bullEngulf/threeInsideUp/rocket individually on this fixture'));
  console.log('every changed row attributed to at least one of E3/E4/E5: ' + unattributed +
    (unattributed === 0 ? ' (holds)' : ' — SEE ABOVE, THIS IS A BUG'));
}

// Step 8 H11 (Remediation spec, 2026-09-21/22): patternRecords[] on the research fit. Reports,
// per pass, how many research rows carry >= 1 record, records per pattern, and two invariants
// checked on every research row in the pinned slice: every record's candleIds resolve to
// candles in the slice (and its ohlc matches those candles), and every fired pattern flag has
// exactly one record (and no record exists for a flag that is false). Reads only the exported
// detectChannel output - no local re-derivation of any pattern test. No detector code is
// compared OLD-vs-NEW here: patternRecords is a new field, flag-off output is covered by the
// local step8-h11-invariant-tests.js suite.
const H11_PATTERNS = ['bb3', 'bullEngulf', 'threeInsideUp', 'rocket', 'bb3UpperReversion', 'threeInsideDown'];

function runStep8H11Acceptance(current, grids, gridCaches, dailyCaches) {
  var latestGrid = grids[grids.length - 1];
  var latestGridDate = latestGrid.date;
  var coins = latestGrid.coins;

  console.log('\n=== Step 8 H11 acceptance (patternRecords on the research fit) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }

  var badTotal = 0;
  for (var ti = 0; ti < 2; ti++) {
    var tf = ['1d', '4d-grid'][ti];
    var checked = 0, withRecord = 0, records = 0, flagsTrue = 0, bad = [];
    var perPattern = {};
    H11_PATTERNS.forEach(function (p) { perPattern[p] = 0; });
    for (var ci = 0; ci < coins.length; ci++) {
      var cgId = coins[ci];
      var s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      var newR = null;
      try { newR = current.detectChannel(s, undefined, { cgId: cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      if (!newR) continue; // row set = rows with a research fit
      checked++;
      var recs = newR.patternRecords || [];
      if (recs.length >= 1) withRecord++;
      records += recs.length;

      var byTime = {};
      for (var si = 0; si < s.length; si++) byTime[s[si].time] = s[si];
      var problems = [];
      for (var ri = 0; ri < recs.length; ri++) {
        var r = recs[ri];
        if (perPattern[r.pattern] !== undefined) perPattern[r.pattern]++;
        else problems.push('unknown pattern ' + r.pattern);
        if (!r.candleIds || !r.candleIds.length) problems.push(r.pattern + ': empty candleIds');
        for (var k = 0; k < (r.candleIds || []).length; k++) {
          var cd = byTime[r.candleIds[k]];
          if (!cd) { problems.push(r.pattern + ': candleId ' + r.candleIds[k] + ' not in slice'); continue; }
          var o = r.ohlc && r.ohlc[k];
          if (!o || o.time !== cd.time || o.open !== cd.open || o.high !== cd.high || o.low !== cd.low || o.close !== cd.close) {
            problems.push(r.pattern + ': ohlc[' + k + '] does not match slice candle');
          }
        }
      }
      for (var pi = 0; pi < H11_PATTERNS.length; pi++) {
        var pn = H11_PATTERNS[pi];
        var nRec = recs.filter(function (x) { return x.pattern === pn; }).length;
        var flag = !!newR[pn];
        if (flag) flagsTrue++;
        if (nRec !== (flag ? 1 : 0)) problems.push(pn + ': flag ' + flag + ' but ' + nRec + ' record(s)');
      }
      if (problems.length) bad.push({ cgId: cgId, problems: problems });
    }
    console.log(tf + ': research rows ' + checked + ' | rows with >=1 record: ' + withRecord + ' | records: ' + records +
      ' (pattern flags true: ' + flagsTrue + ') | per pattern: ' +
      H11_PATTERNS.map(function (p) { return p + '=' + perPattern[p]; }).join(' '));
    for (var bi = 0; bi < bad.length; bi++) console.log('    VIOLATION ' + bad[bi].cgId + ': ' + bad[bi].problems.join('; '));
    badTotal += bad.length;
  }
  console.log('invariant (every record candleId resolves to a slice candle with matching OHLC; every fired flag has exactly one record, no record for a false flag): ' +
    (badTotal === 0 ? 'holds on every research row, both passes' : badTotal + ' row(s) violate - SEE ABOVE, THIS IS A BUG'));
}

// Step 9 F3/H3 (Remediation spec, 2026-09-21/22): outlier-wick clip + sensitivity readout.
// OLD = current.detectChannel(... {research:true, _noWickClip:true}) - the SAME research function with
// the clip switched off (harness lever, never set by capture.js or the page); NEW = default. Per pass:
// population of clipped bars (applyWickClip run directly on every slice - independent of whether the
// coin has a research fit), then over rows with a research fit on either side: how many changed and why.
// Every changed row is attributed to exactly one of
//   "clip moved pivot set"          - findPivotsWindowed on the raw vs analytic series gives different pivot idx sets
//   "clip changed containment"      - same pivot set, containment differs (or the fit appears/vanishes on the 55% gate)
//   "clip changed rail delta only"  - same pivot set and containment, rail/score differ (analytic pivot price)
// anything else prints as a BUG. Compared field-for-field on the fit with wickClips stripped (OLD has none).
// H3 table: wickClips entries on research fits, pivot candidates, computed deltas, how many exceed
// F3_RAIL_UNCHANGED_PCT, and the reason counts for the rest. Per-timeframe only (fixtures carry no
// dailySource - venue breakdown is a post-push check against live data/latest-daily.json).
function runStep9F3H3Acceptance(current, grids, gridCaches, dailyCaches) {
  var latestGrid = grids[grids.length - 1];
  var latestGridDate = latestGrid.date;
  var coins = latestGrid.coins;

  console.log('\n=== Step 9 F3/H3 acceptance (outlier-wick clip, ATR14 as of bar i-1; H3 sensitivity) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' (used for 4d-grid) | 1d pinned date: ' + FROZEN_916_DATE + ' (used for 1d - frozen capture, see pinnedSlice) | coin universe: ' + coins.length +
    ' | F3_WICK_ATR_MULT=' + current.F3_WICK_ATR_MULT + ' F3_CLIP_ATR_MULT=' + current.F3_CLIP_ATR_MULT + ' F3_RAIL_UNCHANGED_PCT=' + current.F3_RAIL_UNCHANGED_PCT);

  function slice(cgId, tf) {
    return pinnedSlice(cgId, tf, gridCaches, dailyCaches, latestGridDate);
  }
  function sig(list) { return list.map(function (p) { return p.idx; }).join(','); }
  function stripClips(fit) { if (!fit) return null; var o = Object.assign({}, fit); delete o.wickClips; return JSON.stringify(o); }

  var bugTotal = 0;
  for (var ti = 0; ti < 2; ti++) {
    var tf = ['1d', '4d-grid'][ti];
    var w = (tf === '1d') ? current.FIT_WINDOW : current.FIT_WINDOW_GRID;
    var sliced = 0, clipLow = 0, clipHigh = 0, coinsWithClip = 0;
    var rows = 0, changed = [], classes = { 'clip moved pivot set': 0, 'clip changed containment': 0, 'clip changed rail delta only': 0 };
    var entries = 0, pivotEntries = 0, computed = 0, exceed = 0, reasons = {}, rowsWithClips = 0;
    for (var ci = 0; ci < coins.length; ci++) {
      var cgId = coins[ci];
      var s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      sliced++;
      var from = s.length > w ? s.length - w : 0;
      var clipRes = current.applyWickClip(s, from);
      var lo = clipRes.clips.filter(function (c) { return c.side === 'low'; }).length;
      var hi = clipRes.clips.length - lo;
      clipLow += lo; clipHigh += hi; if (clipRes.clips.length) coinsWithClip++;

      var meta = { cgId: cgId, timeframe: tf, source: 'fixture', research: true };
      var oldR = null, newR = null;
      try { oldR = current.detectChannel(s, undefined, Object.assign({ _noWickClip: true }, meta)); } catch (e) { /* null */ }
      try { newR = current.detectChannel(s, undefined, meta); } catch (e) { /* null */ }
      if (!oldR && !newR) continue;
      rows++;
      if (newR && newR.wickClips.length) {
        rowsWithClips++;
        newR.wickClips.forEach(function (c) {
          entries++;
          if (c.pivot) pivotEntries++;
          if (c.railDeltaPct !== null) { computed++; if (!c.railUnchanged) exceed++; }
          else reasons[c.reason] = (reasons[c.reason] || 0) + 1;
        });
      }
      if (stripClips(oldR) === stripClips(newR)) continue;
      var rawPv = current.findPivotsWindowed(s, w), aPv = current.findPivotsWindowed(clipRes.analytic, w);
      var cls = null;
      if (sig(rawPv.lows) !== sig(aPv.lows) || sig(rawPv.highs) !== sig(aPv.highs)) cls = 'clip moved pivot set';
      else if (!oldR || !newR || oldR.containmentFull !== newR.containmentFull || oldR.containmentRecent !== newR.containmentRecent) cls = 'clip changed containment';
      else if (oldR.supportNow !== newR.supportNow || oldR.resistNow !== newR.resistNow || oldR.score !== newR.score) cls = 'clip changed rail delta only';
      if (cls) classes[cls]++; else bugTotal++;
      changed.push({ cgId: cgId, cls: cls || 'UNATTRIBUTED - BUG', o: oldR ? oldR.score + '/' + oldR.lifecycleState : 'null', n: newR ? newR.score + '/' + newR.lifecycleState : 'null' });
    }
    console.log('\n' + tf + ': slices ' + sliced + ' | population clipped bars in fit window: low ' + clipLow + ', high ' + clipHigh + ' (coins with >=1: ' + coinsWithClip + ')');
    console.log('    research rows (either side) ' + rows + ' | rows carrying wickClips ' + rowsWithClips + ' | changed rows (fit fields excl. wickClips) ' + changed.length +
      ' | moved pivot set ' + classes['clip moved pivot set'] + ', changed containment ' + classes['clip changed containment'] + ', rail delta only ' + classes['clip changed rail delta only']);
    changed.forEach(function (c) { console.log('      ' + c.cgId.padEnd(28) + ' ' + c.cls + '  (score/state OLD ' + c.o + ' -> NEW ' + c.n + ')'); });
    console.log('    H3: wickClips entries ' + entries + ' | pivot candidates ' + pivotEntries + ' | railDeltaPct computed ' + computed + ' (>= ' + current.F3_RAIL_UNCHANGED_PCT + '%: ' + exceed + ') | not computed: ' +
      (Object.keys(reasons).length ? Object.keys(reasons).map(function (k) { return k + '=' + reasons[k]; }).join(' ') : 'none'));
  }
  console.log('\nevery changed row attributed to pivot set / containment / rail delta: ' + (bugTotal === 0 ? 'holds' : bugTotal + ' UNATTRIBUTED - SEE ABOVE, THIS IS A BUG') +
    ' (full 2162-row versions in radar_tools/step9-invariant-tests.js, local only)');
}

// Step 10 D (Remediation spec Plan D; plan + review decisions in the step 8-10 log): research score rebalance.
// OLD = the same research fit with meta._noD (the pre-D block, in the same function); NEW = the D block. Measured on
// EVERY dated fixture (all grid dates x their coins; 1d rows from ohlcDaily sliced to the same date where >= 60 daily
// bars exist), NOT pinned to the frozen date - the floor decision needs the whole population. Aggregates only, per
// timeframe. No floor is chosen here. The ACT counts below are a SCORE + core-field PROXY (eligible lifecycle AND
// distToRailPct <= min(2*tol, 0.06) AND channelH/price <= 0.40 AND score >= floor); the real buildAction verdict lives
// in radar.html and is measured by the local step10-floor-table.js - that table is the source of truth.
// Structural grid ceiling: grid bars carry no volume and the pattern bonus is 1D-only, so a grid row's best raw is
// 24+15+15+15+12+6+(5+3) = 95 -> 93.1 after the x100/102 rescale; the floor must be derived per timeframe (step 11).
function runStep10DAcceptance(current, grids, gridCaches, dailyCaches) {
  var FLOORS = [80, 82, 84, 86, 88, 90];
  console.log('\n=== Step 10 D acceptance (scoring rebalance) — research fits, ALL ' + grids.length + ' dated fixtures, per timeframe (1d on ohlcDaily with volume, 4d-grid on ohlc) ===');
  console.log('OLD = research fit with _noD (55% on wicks, additive block); NEW = D block (70% on closes, table x100/102). ACT_SCORE_FLOOR stays 89 (page); candidate floors ' + FLOORS.join('/') + ' printed as counts only.');
  console.log('GRID CEILING (structural): no volume on grid bars, pattern bonus 1D-only => max raw 95 => ' + (95 * 100 / current.D_RAW_MAX).toFixed(1) + ' after rescale; per-timeframe floor needed in step 11.');
  console.log('Constants: D_RAW_MAX=' + current.D_RAW_MAX + ' D_CONT_GATE=' + current.D_CONT_GATE + ' D_AGE_RANGE=' + JSON.stringify(current.D_AGE_RANGE) + ' D_AGE_RANGE_GRID=' + JSON.stringify(current.D_AGE_RANGE_GRID) + ' D_BREAK_PENALTY=' + current.D_BREAK_PENALTY + ' D_VOL_TOUCH_MULT=' + current.D_VOL_TOUCH_MULT + ' D_EMA_SLOPE_BARS=' + current.D_EMA_SLOPE_BARS);
  function rankAvg(a) {
    var idx = a.map(function (v, i) { return i; }).sort(function (x, y) { return a[x] - a[y]; }), r = new Array(a.length), i = 0;
    while (i < idx.length) { var j = i; while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++; var av = (i + j) / 2 + 1; for (var k = i; k <= j; k++) r[idx[k]] = av; i = j + 1; }
    return r;
  }
  function spearman(x, y) {
    if (x.length < 3) return null;
    var rx = rankAvg(x), ry = rankAvg(y), n = x.length, mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; } mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) * (rx[i] - mx); syy += (ry[i] - my) * (ry[i] - my); }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
  }
  function pct(sorted, q) { if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }
  function proxyAct(f, floor) {
    if (!f || f.score < floor) return false;
    if (!(f.lifecycleState === 'intact' || f.lifecycleState === 're-qualified')) return false;
    if (f.distToRailPct > Math.min(2 * f.tol, 0.06)) return false;
    if (f.channelH / f.detectionPrice > 0.40) return false;
    return true;
  }
  var bugs = 0;
  ['1d', '4d-grid'].forEach(function (tf) {
    var src = (tf === '1d') ? dailyCaches : gridCaches, minBars = (tf === '1d') ? 60 : 30;
    var rows = 0, bothFit = 0, oldOnly = 0, newOnly = 0, samePairScoreChanged = 0, pairChanged = 0;
    var oldS = [], newS = [], both = [], hist = new Array(21).fill(0), maxNew = -1, maxOld = -1, lostByDate = [];
    var volBonusRows = 0, patBonusRows = 0, brkRows = 0, widthPenRows = 0, ageZero = 0, sumParts = {}, nParts = 0;
    var perDate = [], anyDate = 0;
    grids.forEach(function (g) {
      var nRows = 0, lost = 0, oldAct = 0, act = FLOORS.map(function () { return 0; }), fits = 0;
      g.coins.forEach(function (cgId) {
        var c = src[cgId]; if (!c) return;
        var s = sliceToDate(c, g.date); if (!s || s.length < minBars) return;
        var meta = { coinId: cgId, timeframe: tf, source: 'fixture', research: true, _noH3: true };
        var oldF = current.detectChannel(s, null, Object.assign({ _noD: true }, meta));
        var newF = current.detectChannel(s, null, meta);
        rows++; nRows++;
        if (oldF && !newF) { oldOnly++; lost++; }
        if (!oldF && newF) newOnly++;
        if (oldF && proxyAct(oldF, 89)) oldAct++;
        if (newF) {
          fits++;
          var b = newF.scoreBreakdown;
          if (!b) { bugs++; console.log('  BUG: NEW research fit without scoreBreakdown ' + cgId + ' ' + tf + ' ' + g.date); return; }
          if (newF.score < 0 || newF.score > 100) { bugs++; console.log('  BUG: score out of range ' + cgId + ' ' + tf + ' ' + g.date); }
          hist[Math.min(20, Math.floor(newF.score / 5))]++;
          if (newF.score > maxNew) maxNew = newF.score;
          if (b.vol > 0) volBonusRows++; if (b.pattern > 0) patBonusRows++; if (b.penalties.brk > 0) brkRows++; if (b.penalties.width > 0) widthPenRows++; if (b.age === 0) ageZero++;
          ['touch', 'res', 'cont', 'slope', 'pos', 'age', 'ema', 'emaSlope', 'pattern', 'vol'].forEach(function (k) { sumParts[k] = (sumParts[k] || 0) + b[k]; }); nParts++;
          FLOORS.forEach(function (fl, i) { if (proxyAct(newF, fl)) act[i]++; });
        }
        if (oldF && oldF.score > maxOld) maxOld = oldF.score;
        if (oldF && newF) {
          bothFit++; oldS.push(oldF.score); newS.push(newF.score);
          var samePair = (oldF.firstIdx === newF.firstIdx && oldF.supSlope === newF.supSlope);
          if (!samePair) pairChanged++; else if (oldF.score !== newF.score) samePairScoreChanged++;
        }
      });
      if (nRows) { anyDate++; perDate.push(g.date + ' n=' + nRows + ' fits=' + fits + ' lost=' + lost + ' oldACT89=' + oldAct + ' | ' + FLOORS.map(function (fl, i) { return fl + ':' + act[i]; }).join(' ')); }
    });
    console.log('\n--- ' + tf + ': rows scored ' + rows + ' over ' + anyDate + ' dates | both fit ' + bothFit + ' | fit lost to the 70%-on-closes gate (OLD fit, NEW none) ' + oldOnly + ' | NEW-only fits ' + newOnly + ' | winning pair changed ' + pairChanged + ' | same pair, score changed ' + samePairScoreChanged + ' | max score old ' + maxOld + ' new ' + maxNew + ' ---');
    var nNew = hist.reduce(function (a, b) { return a + b; }, 0);
    console.log('NEW score histogram (5-pt bins, n=' + nNew + '): ' + hist.map(function (v, i) { return (i === 20 ? '100' : (i * 5) + '-' + (i * 5 + 4)) + ':' + v; }).join(' '));
    console.log('bonus/penalty incidence (NEW rows): vol bonus ' + volBonusRows + ' | pattern bonus ' + patBonusRows + ' | break penalty ' + brkRows + ' | width penalty ' + widthPenRows + ' | age 0 ' + ageZero + ' | mean parts ' + Object.keys(sumParts).map(function (k) { return k + '=' + (sumParts[k] / Math.max(1, nParts)).toFixed(1); }).join(' '));
    var rho = spearman(oldS, newS), moved10 = 0, i;
    for (i = 0; i < oldS.length; i++) if (Math.abs(oldS[i] - newS[i]) >= 10) moved10++;
    console.log('OLD vs NEW on rows with both fits (n=' + oldS.length + '): Spearman rho ' + (rho == null ? 'n/a' : rho.toFixed(3)) + ' | rows moved >= 10 points ' + moved10);
    console.log('rows crossing (OLD >= 89 / OLD < 89) x (NEW >= cutoff): ' + [80, 82, 84, 86, 88, 90].map(function (cut) {
      var a = 0, b2 = 0; for (var q = 0; q < oldS.length; q++) if (newS[q] >= cut) { if (oldS[q] >= 89) a++; else b2++; } return cut + ': ' + a + '/' + b2; }).join('  ') + '   (old>=89 total ' + oldS.filter(function (v) { return v >= 89; }).length + ')');
    var so = oldS.slice().sort(function (a, b) { return a - b; }), sn = newS.slice().sort(function (a, b) { return a - b; });
    console.log('percentiles P50/P75/P90/P95/P99  OLD ' + [0.5, 0.75, 0.9, 0.95, 0.99].map(function (q) { return pct(so, q); }).join('/') + '  NEW ' + [0.5, 0.75, 0.9, 0.95, 0.99].map(function (q) { return pct(sn, q); }).join('/'));
    var pe = [89, 75, 60].map(function (cut) { var below = so.filter(function (v) { return v < cut; }).length / Math.max(1, so.length); return { cut: cut, share: below, eq: pct(sn, below) }; });
    console.log('population-equivalent cutoffs (score at the same percentile as OLD 89/75/60; row shares OLD>=cutoff): ' + pe.map(function (e) { return e.cut + ' -> NEW ' + e.eq + ' (' + ((1 - e.share) * 100).toFixed(1) + '% of rows)'; }).join(' | '));
    console.log('per date (ACT proxy counts under floors; oldACT89 = OLD research proxy at 89; lost = fits lost to the 70% gate):');
    perDate.forEach(function (l) { console.log('  ' + l); });
  });
  console.log('\nPrior-section deltas: flag-off output unchanged (local step10 suite: deep-equal 2162/2162). Step 9 section above now measures D-mode fits on both sides (OLD there = _noWickClip). Containment for score and gate is measured on raw closes, so a clipped bar can no longer change containment DIRECTLY; the Step 9 classifier still labels a changed row "clip changed containment" whenever containmentFull/containmentRecent differ, and that still happens when a clipped HIGH pivot moves the resistance rail (the closes are judged against the moved rail) - e.g. tron 9/16 1d. The class stays reachable; its meaning is now "clip moved the resistance rail / winning pair", not "clip changed a wick-based containment".');
  if (bugs) { console.log('Step 10 D acceptance: ' + bugs + ' BUG line(s) above'); process.exitCode = 1; }
}

// Step 11-A (Remediation spec Plan C / Verdict sequence; step 11 plan 11-A, analysis-thread rulings k/b/a/o): research
// verdicts from channel-core.js's pure researchVerdict() on every dated fixture, per timeframe. Replaces the local
// step10-floor-table.js (which extracted buildAction from radar.html). ctx on the runner: price = the fit's own
// detectionPrice (ruling o / BLOCKS #1 side-finding: the grid capture's `price` is another venue/timestamp and produces
// spurious quote breaches), volume24h = the dated fixture row's volume24h (capture-time CoinGecko), btc = 
// btcRegimeFromCandles(bitcoin ohlcDaily sliced to the date), quote = null (11-D), floor = the per-timeframe constant.
// OLD@89 reference per date = the step 10 floor table (real buildAction, rows with a flag-off fit; 1411 rows) - a
// different population from the research rows counted here, printed for orientation only.
var STEP10_OLD89_1D = { '2026-06-16':0,'2026-06-20':0,'2026-06-24':0,'2026-06-28':1,'2026-07-02':1,'2026-07-06':1,'2026-07-10':0,'2026-07-14':2,'2026-07-18':2,'2026-07-22':0,'2026-07-26':3,'2026-07-30':0,'2026-08-03':1,'2026-08-07':0,'2026-08-11':1,'2026-08-15':1,'2026-08-19':0,'2026-08-23':0,'2026-08-27':0,'2026-08-31':0,'2026-09-04':0,'2026-09-08':1,'2026-09-12':0,'2026-09-16':4 };
function loadGridRowMeta() {
  const out = {};
  const gridDirs = fs.readdirSync(FIXTURES_DATA_DIR, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'cache').map(e => e.name);
  for (const dir of gridDirs) {
    for (const f of fs.readdirSync(path.join(FIXTURES_DATA_DIR, dir)).filter(f => f.endsWith('.json'))) {
      const g = JSON.parse(fs.readFileSync(path.join(FIXTURES_DATA_DIR, dir, f), 'utf8'));
      out[g.date] = {};
      g.coins.forEach(c => { out[g.date][c.cgId] = { volume24h: (c.volume24h != null ? c.volume24h : null), price: c.price }; });
    }
  }
  return out;
}
function runStep11AAcceptance(current, grids, gridCaches, dailyCaches) {
  console.log('\n=== Step 11-A acceptance (research verdict engine, C1-C7 + H6 stub; 16 gates - rail slope is a label, thirds are not a gate) — researchVerdict() on research fits, ALL ' + grids.length + ' dated fixtures, per timeframe ===');
  console.log('Floors: ACT_SCORE_FLOOR_1D=' + current.ACT_SCORE_FLOOR_1D + ' ACT_SCORE_FLOOR_GRID=' + current.ACT_SCORE_FLOOR_GRID + ' (both PROVISIONAL) | C3_FRESH_BARS=' + current.C3_FRESH_BARS + '/' + current.C3_FRESH_BARS_GRID + ' ACT_WIDTH_MAX=' + current.ACT_WIDTH_MAX + ' C2 min(' + current.C2_DIST_TOL_MULT + '*tol,' + current.C2_DIST_CAP + ') C4 ' + current.C4_VOLUME24H_MIN + '/' + current.C4_VOL_TOUCH_MIN + ' C6 ' + current.C6_SPIKE_BARS + 'bars>' + current.C6_SPIKE_ATR_MULT + 'xATR H6_RR_MIN=' + current.H6_RR_MIN);
  console.log('11-B made gate 13 (H6.rr) live (fit.entryEconomics.netRR; Unknown only when no target sits above the entry), so ACT here is real; "ACT-except-rr" = every gate but H6.rr passes. Grid rows fail gate 15 (C4.touch-volume) by construction: grid candles carry no volume (BACKLOG F5 extension).');
  if (typeof current.researchVerdict !== 'function') { console.log('  BUG: researchVerdict not exported'); process.exitCode = 1; return; }
  const meta = loadGridRowMeta();
  let bugs = 0, impure = 0, order = 0;
  const btcSeries = dailyCaches['bitcoin'] || null;
  if (!btcSeries) console.log('  NOTE: no bitcoin daily cache in fixtures -> ctx.btc null on every row (C5 fails as Unknown).');
  const dailyOldShare = { n: 0, ge89: 0 };
  const gridNewScores = [];
  ['1d', '4d-grid'].forEach(function (tf) {
    const src = (tf === '1d') ? dailyCaches : gridCaches, minBars = (tf === '1d') ? 60 : 30, floor = (tf === '1d') ? current.ACT_SCORE_FLOOR_1D : current.ACT_SCORE_FLOOR_GRID;
    let rows = 0, fits = 0, exceptRrTotal = 0, gateIds = null; const verdicts = { ACT: 0, WATCH: 0, WAIT: 0, NONE: 0 }, firstFail = {}, allFail = {}, allUnknown = {}, perDate = [];
    const frozen = { firstFail: {}, exceptRr: [], lifecycle: {} };
    grids.forEach(function (g) {
      const btc = btcSeries ? current.btcRegimeFromCandles(sliceToDate(btcSeries, g.date) || []) : null;
      let nRows = 0, nFits = 0; const v = { ACT: 0, WATCH: 0, WAIT: 0, NONE: 0 }; let exceptRr = 0; const exceptRrIds = [];
      g.coins.forEach(function (cgId) {
        const c = src[cgId]; if (!c) return;
        const s = sliceToDate(c, g.date); if (!s || s.length < minBars) return;
        const m = { coinId: cgId, timeframe: tf, source: 'fixture', research: true, _noH3: true };
        const fit = current.detectChannel(s, null, m);
        if (tf === '1d') { const oldF = current.detectChannel(s, null, Object.assign({ _noD: true }, m)); if (oldF) { dailyOldShare.n++; if (oldF.score >= 89) dailyOldShare.ge89++; } }
        if (tf === '4d-grid' && fit) gridNewScores.push(fit.score);
        const rowMeta = (meta[g.date] && meta[g.date][cgId]) || {};
        const ctx = { price: fit ? fit.detectionPrice : s[s.length - 1].close, volume24h: rowMeta.volume24h != null ? rowMeta.volume24h : null, btc: btc, quote: null, floor: floor };
        const res = current.researchVerdict(fit, ctx);
        const res2 = current.researchVerdict(fit, ctx);
        if (JSON.stringify(res) !== JSON.stringify(res2)) impure++;
        rows++; nRows++; if (fit) { fits++; nFits++; }
        verdicts[res.verdict]++; v[res.verdict]++;
        const gs = res.details.gates; if (!gateIds) gateIds = gs.map(x => x.id);
        let seenFail = false;
        gs.forEach(function (gt) {
          if (gt.pass !== true) { allFail[gt.id] = (allFail[gt.id] || 0) + 1; if (gt.pass === null) allUnknown[gt.id] = (allUnknown[gt.id] || 0) + 1; }
          if (seenFail && gt.id === res.gate) order++;
          if (gt.pass !== true && !seenFail) { seenFail = true; if (gt.id !== res.gate) order++; }
        });
        if (res.gate) firstFail[res.gate] = (firstFail[res.gate] || 0) + 1;
        if (res.verdict === 'ACT' && !(fit && fit.entryEconomics)) { bugs++; console.log('  BUG: ACT without entryEconomics (rr stub bypassed) ' + cgId + ' ' + tf + ' ' + g.date); }
        const failing = gs.filter(x => x.pass !== true).map(x => x.id);
        if (failing.length === 1 && failing[0] === 'H6.rr') { exceptRr++; exceptRrIds.push(cgId); }
        if (tf === '1d' && g.date === FROZEN_916_DATE) {
          if (res.gate) { (frozen.firstFail[res.gate] = frozen.firstFail[res.gate] || []).push(cgId + (res.gate === 'struct.lifecycle' ? '(' + fit.lifecycleState + ')' : '')); }
          if (fit) frozen.lifecycle[fit.lifecycleState] = (frozen.lifecycle[fit.lifecycleState] || 0) + 1;
          if (failing.length === 1 && failing[0] === 'H6.rr') frozen.exceptRr.push(cgId);
        }
      });
      if (nRows) { exceptRrTotal += exceptRr; perDate.push(g.date + ' n=' + nRows + ' fits=' + nFits + ' ACT/WATCH/WAIT/NONE=' + v.ACT + '/' + v.WATCH + '/' + v.WAIT + '/' + v.NONE + ' ACT-except-rr=' + exceptRr + (tf === '1d' ? ' (OLD@89 ref ' + (STEP10_OLD89_1D[g.date] == null ? '?' : STEP10_OLD89_1D[g.date]) + ')' : '') + (exceptRrIds.length ? ' [' + exceptRrIds.join(',') + ']' : '')); }
    });
    console.log('\n--- ' + tf + ': rows ' + rows + ' | research fits ' + fits + ' | verdicts ACT ' + verdicts.ACT + ' WATCH ' + verdicts.WATCH + ' WAIT ' + verdicts.WAIT + ' NONE ' + verdicts.NONE + ' | ACT-except-rr total ' + exceptRrTotal + (tf === '1d' ? ' (OLD@89 ref total ' + Object.keys(STEP10_OLD89_1D).reduce((a, k) => a + STEP10_OLD89_1D[k], 0) + ', different population)' : '') + ' ---');
    console.log('first-failing gate (what stops each row): ' + (gateIds || []).map(id => id + ':' + (firstFail[id] || 0)).join(' '));
    console.log('all-gate failures (non-short-circuit, incl. Unknown): ' + (gateIds || []).map(id => id + ':' + (allFail[id] || 0) + (allUnknown[id] ? '(unk ' + allUnknown[id] + ')' : '')).join(' '));
    console.log('per date:'); perDate.forEach(l => console.log('  ' + l));
    if (tf === '1d') {
      console.log('frozen ' + FROZEN_916_DATE + ' 1d observations (per-coin landings, recorded, not asserted): lifecycle ' + JSON.stringify(frozen.lifecycle));
      Object.keys(frozen.firstFail).forEach(k => console.log('  ' + k + ' (' + frozen.firstFail[k].length + '): ' + frozen.firstFail[k].join(', ')));
      console.log('  ACT-except-rr (' + frozen.exceptRr.length + '): ' + (frozen.exceptRr.join(', ') || '(none)'));
    }
  });
  const p = dailyOldShare.n ? dailyOldShare.ge89 / dailyOldShare.n : null;
  const sorted = gridNewScores.slice().sort((a, b) => a - b);
  let derived = null;
  if (p != null && sorted.length) { for (let f = 0; f <= 100; f++) { const share = sorted.filter(x => x >= f).length / sorted.length; if (share <= p) { derived = f; break; } } }
  console.log('\nACT_SCORE_FLOOR_GRID derivation (ruling k/b): 1d research rows with an OLD (_noD) fit ' + dailyOldShare.n + ', OLD>=89 ' + dailyOldShare.ge89 + ' (share ' + (p == null ? 'n/a' : (p * 100).toFixed(2) + '%') + ') | grid NEW research fits ' + sorted.length + ', max ' + (sorted.length ? sorted[sorted.length - 1] : 'n/a') + ' | smallest floor whose grid share <= that share: ' + derived + ' | constant ACT_SCORE_FLOOR_GRID=' + current.ACT_SCORE_FLOOR_GRID + ' -> ' + (derived === current.ACT_SCORE_FLOOR_GRID ? 'MATCH' : 'MISMATCH (re-set the constant)'));
  if (derived !== null && derived !== current.ACT_SCORE_FLOOR_GRID) { bugs++; console.log('  BUG: ACT_SCORE_FLOOR_GRID does not match its stated derivation'); }
  console.log('purity (same input twice, deep-equal): ' + (impure ? impure + ' MISMATCH' : 'ok') + ' | gate-order (first pass!==true equals reported gate): ' + (order ? order + ' MISMATCH' : 'ok'));
  if (impure || order) bugs++;
  console.log('Prior-section deltas: none - researchVerdict is additive (new exports + constants); detectChannel research and flag-off outputs are byte-identical to 5be7385b (local step11-a suite), so every earlier section prints the same numbers.');
  if (bugs) { console.log('Step 11-A acceptance: ' + bugs + ' BUG line(s) above'); process.exitCode = 1; }
}

// Step 11-B (Remediation spec H6; step 11 plan 11-B; rulings c/d/e/f/g): entry economics on every research fit and the first
// REAL research ACT count (gate 13 H6.rr now reads fit.entryEconomics.netRR; gate 11 is C2.entry-zone). Same ctx as 11-A.
function runStep11BAcceptance(current, grids, gridCaches, dailyCaches) {
  console.log('\n=== Step 11-B acceptance (H6 entry economics: zone / stop / target / R:R; C2.entry-zone replaces C2.distance) — ALL ' + grids.length + ' dated fixtures, per timeframe ===');
  console.log('Constants: H6_ENTRY_ATR=' + current.H6_ENTRY_ATR + ' H6_STOP_ATR=' + current.H6_STOP_ATR + ' H6_STOP_CAP_ATR=' + current.H6_STOP_CAP_ATR + ' H6_COST_PCT=' + current.H6_COST_PCT + ' H6_SWING_WINDOW=' + current.H6_SWING_WINDOW + '/' + current.H6_SWING_WINDOW_GRID + ' H6_RR_MIN=' + current.H6_RR_MIN + ' | floors ' + current.ACT_SCORE_FLOOR_1D + '/' + current.ACT_SCORE_FLOOR_GRID + ' (all PROVISIONAL)');
  if (typeof current.entryEconomicsOf !== 'function') { console.log('  BUG: entryEconomicsOf not exported'); process.exitCode = 1; return; }
  const meta = loadGridRowMeta(); const btcSeries = dailyCaches['bitcoin'] || null; let bugs = 0;
  ['1d', '4d-grid'].forEach(function (tf) {
    const src = (tf === '1d') ? dailyCaches : gridCaches, minBars = (tf === '1d') ? 60 : 30, floor = (tf === '1d') ? current.ACT_SCORE_FLOOR_1D : current.ACT_SCORE_FLOOR_GRID;
    let fits = 0, eeNull = 0; const rrHist = { 'null': 0, '<0': 0, '0-1': 0, '1-2': 0, '2-3': 0, '3-5': 0, '5+': 0 }, tgt = {}, stopB = {}, firstFail = {}, verdicts = { ACT: 0, WATCH: 0, WAIT: 0, NONE: 0 }, perDate = []; let gateIds = null, actTotal = 0, zoneIn = 0, zoneKnown = 0;
    grids.forEach(function (g) {
      const btc = btcSeries ? current.btcRegimeFromCandles(sliceToDate(btcSeries, g.date) || []) : null;
      let act = 0; const actIds = []; let n = 0;
      g.coins.forEach(function (cgId) {
        const c = src[cgId]; if (!c) return; const s = sliceToDate(c, g.date); if (!s || s.length < minBars) return; n++;
        const fit = current.detectChannel(s, null, { coinId: cgId, timeframe: tf, source: 'fixture', research: true, _noH3: true });
        const rowMeta = (meta[g.date] && meta[g.date][cgId]) || {};
        const res = current.researchVerdict(fit, { price: fit ? fit.detectionPrice : s[s.length - 1].close, volume24h: rowMeta.volume24h != null ? rowMeta.volume24h : null, btc: btc, quote: null, floor: floor });
        verdicts[res.verdict]++; if (res.gate) firstFail[res.gate] = (firstFail[res.gate] || 0) + 1;
        if (!gateIds) gateIds = res.details.gates.map(x => x.id);
        if (res.details.gates.some(x => x.id === 'C2.distance')) { bugs++; console.log('  BUG: C2.distance still present'); }
        if (!fit) return; fits++;
        const ee = fit.entryEconomics;
        if (!ee) { eeNull++; return; }
        tgt[ee.targetSource] = (tgt[ee.targetSource] || 0) + 1; stopB[ee.stopBasis] = (stopB[ee.stopBasis] || 0) + 1;
        const v = ee.netRR; rrHist[v == null ? 'null' : v < 0 ? '<0' : v < 1 ? '0-1' : v < 2 ? '1-2' : v < 3 ? '2-3' : v < 5 ? '3-5' : '5+']++;
        if (!(ee.stop <= ee.entryRef)) { bugs++; console.log('  BUG: stop above entryRef ' + cgId + ' ' + tf + ' ' + g.date); }
        if ((v == null) !== (ee.target == null)) { bugs++; console.log('  BUG: netRR/target null mismatch ' + cgId); }
        zoneKnown++; if (fit.detectionPrice >= ee.entryZone[0] && fit.detectionPrice <= ee.entryZone[1]) zoneIn++;
        if (res.verdict === 'ACT') { act++; actIds.push(cgId + '(rr ' + v.toFixed(2) + ',' + ee.targetSource[0] + ')'); if (!(v >= current.H6_RR_MIN)) { bugs++; console.log('  BUG: ACT with netRR < min ' + cgId); } }
      });
      if (n) { actTotal += act; perDate.push(g.date + ' n=' + n + ' ACT=' + act + (tf === '1d' ? ' (OLD@89 ref ' + (STEP10_OLD89_1D[g.date] == null ? '?' : STEP10_OLD89_1D[g.date]) + ')' : '') + (actIds.length ? ' [' + actIds.join(', ') + ']' : '')); }
    });
    console.log('\n--- ' + tf + ': research fits ' + fits + ' | entryEconomics null ' + eeNull + ' | target source ' + JSON.stringify(tgt) + ' | stop basis ' + JSON.stringify(stopB) + ' | detectionPrice inside entry zone ' + zoneIn + '/' + zoneKnown + ' ---');
    console.log('netRR histogram: ' + Object.keys(rrHist).map(k => k + ':' + rrHist[k]).join(' '));
    console.log('verdicts ACT ' + verdicts.ACT + ' WATCH ' + verdicts.WATCH + ' WAIT ' + verdicts.WAIT + ' NONE ' + verdicts.NONE + ' | REAL research ACT total ' + actTotal + (tf === '1d' ? ' (OLD@89 ref total 18, different population)' : ''));
    console.log('first-failing gate: ' + (gateIds || []).map(id => id + ':' + (firstFail[id] || 0)).join(' '));
    console.log('per date:'); perDate.forEach(l => console.log('  ' + l));
  });
  console.log('\nPrior-section deltas: the 11-A section above now runs with gate 11 = C2.entry-zone and gate 13 = H6.rr live (its verdict counts, first-failing table and ACT-except-rr line change accordingly; ACT is no longer 0 by construction). detectChannel research output gains the entryEconomics field only; flag-off unchanged (local step11-b suite), so steps 6-10 print the same numbers.');
  if (bugs) { console.log('Step 11-B acceptance: ' + bugs + ' BUG line(s) above'); process.exitCode = 1; }
}

// Step 11-C (Remediation spec H5, option (i); step 11 plan 11-C): replay the 24 dated fixtures through setups-core.js's
// pure updateSetupLedger() as if each were a capture (1d rows only, the timeframe capture.js writes research for; ctx as in
// 11-A/B: price = the fit's own close, volume24h from the dated fixture row, btc per date, ACT_SCORE_FLOOR_1D). Prints
// aggregates only: opens/closes per date, open count at the end, max invalidation raise, breach count, idempotency.
function runStep11CAcceptance(current, grids, gridCaches, dailyCaches) {
  console.log('\n=== Step 11-C acceptance (H5 setup ledger replay via setups-core.js updateSetupLedger; same-rail raises, close at SETUP_BREAK_CLOSES consecutive frozen-rail breaches) — ' + grids.length + ' dated fixtures as captures, 1d ===');
  let S;
  try { S = require(path.join(REPO_ROOT, 'setups-core.js')); } catch (e) { console.log('  BUG: setups-core.js not loadable: ' + e.message); process.exitCode = 1; return; }
  const meta = loadGridRowMeta(); const btcSeries = dailyCaches['bitcoin'] || null; let bugs = 0;
  let ledger = S.emptyLedger(); const perDate = []; let maxRaisePct = 0, raises = 0, breaches = 0, idem = 0, actRows = 0;
  const snapshots = {};
  grids.forEach(function (g) {
    const btc = btcSeries ? current.btcRegimeFromCandles(sliceToDate(btcSeries, g.date) || []) : null;
    const rows = g.coins.map(function (cgId) {
      const c = dailyCaches[cgId]; const s = c ? sliceToDate(c, g.date) : null;
      const fit = (s && s.length >= 60) ? current.detectChannel(s, null, { coinId: cgId, timeframe: '1d', source: 'fixture', research: true, _noH3: true }) : null;
      const rowMeta = (meta[g.date] && meta[g.date][cgId]) || {};
      const res = current.researchVerdict(fit, { price: fit ? fit.detectionPrice : (s && s.length ? s[s.length - 1].close : null), volume24h: rowMeta.volume24h != null ? rowMeta.volume24h : null, btc: btc, quote: null, floor: current.ACT_SCORE_FLOOR_1D });
      if (res.verdict === 'ACT') actRows++;
      return { cgId: cgId, timeframe: '1d', verdict: res.verdict, lifecycleState: fit ? fit.lifecycleState : null, price: fit ? fit.detectionPrice : null,
        fit: fit ? { fitId: fit.fitId, pivotIds: fit.pivotIds || [], supSlope: fit.supSlope, supIntercept: fit.supIntercept, supportNow: fit.supportNow, invalidation: fit.invalidation, entryEconomics: fit.entryEconomics || null } : null };
    });
    const before = ledger, m = { detectorVersion: current.DETECTOR_VERSION, configHash: 'fixture-replay' };
    ledger = S.updateSetupLedger(before, g.date, rows, m);
    const again = S.updateSetupLedger(ledger, g.date, rows, m);
    if (JSON.stringify(again) !== JSON.stringify(ledger)) idem++;
    const opened = ledger.setups.length - before.setups.length;
    const closed = ledger.setups.filter(x => x.status === 'closed').length - before.setups.filter(x => x.status === 'closed').length;
    const open = ledger.setups.filter(x => x.status === 'open').length;
    // invariants across the replay
    before.setups.forEach(function (b) {
      const n = ledger.setups.find(x => x.id === b.id);
      if (!n) { bugs++; console.log('  BUG: record deleted ' + b.id); return; }
      if (n.invalidation < b.invalidation) { bugs++; console.log('  BUG: invalidation lowered ' + b.id); }
      if (n.invalidation > b.invalidation) { raises++; maxRaisePct = Math.max(maxRaisePct, (n.invalidation - b.invalidation) / b.invalidation * 100); }
      if (n.breachHistory.length < b.breachHistory.length || b.breachHistory.some((d, i) => n.breachHistory[i] !== d)) { bugs++; console.log('  BUG: breachHistory shrank/changed ' + b.id); }
      if (b.status === 'closed' && n.status !== 'closed') { bugs++; console.log('  BUG: closed setup reopened ' + b.id); }
    });
    breaches = ledger.setups.reduce((a, x) => a + x.breachHistory.length, 0);
    perDate.push(g.date + ' rows=' + rows.length + ' ACT=' + rows.filter(r => r.verdict === 'ACT').length + ' opened=' + opened + ' closed=' + closed + ' open=' + open + (opened ? ' [' + ledger.setups.slice(-opened).map(x => x.id).join(', ') + ']' : ''));
    snapshots[g.date] = JSON.stringify(ledger);
  });
  console.log('per date (opens/closes/open-at-end):'); perDate.forEach(l => console.log('  ' + l));
  console.log('SETUP_BREAK_CLOSES=' + S.SETUP_BREAK_CLOSES + ' (PROVISIONAL) | raises suppressed (anchor mismatch) ' + ledger.setups.reduce((a, x) => a + x.raisesSuppressed, 0) + ' | live-broken-but-open setups at end ' + ledger.setups.filter(x => x.status === 'open' && x.liveLifecycleState === 'broken').length);
  const openIds = ledger.setups.filter(x => x.status === 'open').map(x => x.id + ' inv ' + x.invalidation + (x.invalidationRaises ? ' (+' + x.invalidationRaises + ' raises)' : '') + (x.raisesSuppressed ? ' (' + x.raisesSuppressed + ' suppressed)' : '') + ' breaches ' + x.breachHistory.length + ' consecutive ' + x.consecutiveBreaches + ' live ' + x.liveLifecycleState);
  console.log('end of replay: setups ' + ledger.setups.length + ' | open ' + ledger.setups.filter(x => x.status === 'open').length + ' | closed ' + ledger.setups.filter(x => x.status === 'closed').length + ' (' + JSON.stringify(ledger.setups.filter(x => x.status === 'closed').reduce((a, x) => { a[x.closeReason] = (a[x.closeReason] || 0) + 1; return a; }, {})) + ') | ACT rows across dates ' + actRows + ' | invalidation raises ' + raises + ', max raise ' + maxRaisePct.toFixed(2) + '% | breach entries ' + breaches + ' | same-day re-run identical on ' + (grids.length - idem) + '/' + grids.length + ' dates');
  openIds.forEach(l => console.log('  open: ' + l));
  console.log('ledger key order (first record): ' + (ledger.setups.length ? Object.keys(ledger.setups[0]).join(',') : '(no setups)'));
  if (idem) { bugs++; console.log('  BUG: ledger not idempotent on ' + idem + ' date(s)'); }
  // Mechanics replay (labelled SYNTHETIC): the real verdict opens one setup on the last date, so raise / breach / close /
  // re-open paths never run on the fixtures. Replay again with a synthetic verdict - ACT := fit present and lifecycle
  // intact|re-qualified - purely to exercise the ledger on real fits. Not a research result; aggregates only.
  let L2 = S.emptyLedger(), raises2 = 0, maxRaise2 = 0, reopened = 0, bugs2 = 0; const closeReasons = {};
  grids.forEach(function (g) {
    const rows = g.coins.map(function (cgId) {
      const c = dailyCaches[cgId]; const s = c ? sliceToDate(c, g.date) : null;
      const fit = (s && s.length >= 60) ? current.detectChannel(s, null, { coinId: cgId, timeframe: '1d', source: 'fixture', research: true, _noH3: true }) : null;
      const elig = !!(fit && (fit.lifecycleState === 'intact' || fit.lifecycleState === 're-qualified'));
      return { cgId: cgId, timeframe: '1d', verdict: elig ? 'ACT' : (fit ? 'WATCH' : 'NONE'), lifecycleState: fit ? fit.lifecycleState : null, price: fit ? fit.detectionPrice : null,
        fit: fit ? { fitId: fit.fitId, pivotIds: fit.pivotIds || [], supSlope: fit.supSlope, supIntercept: fit.supIntercept, supportNow: fit.supportNow, invalidation: fit.invalidation, entryEconomics: fit.entryEconomics || null } : null };
    });
    const before = L2; L2 = S.updateSetupLedger(before, g.date, rows, { detectorVersion: current.DETECTOR_VERSION, configHash: 'synthetic' });
    before.setups.forEach(function (b) { const n = L2.setups.find(x => x.id === b.id); if (!n) { bugs2++; return; } if (n.invalidation < b.invalidation) bugs2++; if (n.invalidation > b.invalidation) { raises2++; maxRaise2 = Math.max(maxRaise2, (n.invalidation - b.invalidation) / b.invalidation * 100); } if (b.status === 'closed' && n.status !== 'closed') reopened++; if (n.breachHistory.length < b.breachHistory.length) bugs2++; });
  });
  L2.setups.filter(x => x.status === 'closed').forEach(x => { closeReasons[x.closeReason] = (closeReasons[x.closeReason] || 0) + 1; });
  const coinsWithMulti = {}; L2.setups.forEach(x => { coinsWithMulti[x.cgId] = (coinsWithMulti[x.cgId] || 0) + 1; });
  console.log('SYNTHETIC mechanics replay (ACT := eligible fit; NOT the research verdict): setups ' + L2.setups.length + ' | open at end ' + L2.setups.filter(x => x.status === 'open').length + ' | closed ' + JSON.stringify(closeReasons) + ' | coins with >1 setup id (new id after close) ' + Object.keys(coinsWithMulti).filter(k => coinsWithMulti[k] > 1).length + ' | invalidation raises ' + raises2 + ' (max ' + maxRaise2.toFixed(2) + '%), suppressed by anchor mismatch ' + L2.setups.reduce((a, x) => a + x.raisesSuppressed, 0) + ' | open setups whose live lifecycle is broken ' + L2.setups.filter(x => x.status === 'open' && x.liveLifecycleState === 'broken').length + ' | breach entries ' + L2.setups.reduce((a, x) => a + x.breachHistory.length, 0) + ' | closed ids reopened ' + reopened + ' | invariant violations ' + bugs2);
  if (bugs2 || reopened) { bugs++; console.log('  BUG: synthetic replay violated a ledger invariant'); }
  console.log('Prior-section deltas: none - channel-core.js is untouched by 11-C (setups-core.js is a new file; capture.js adds a research block + ledger I/O), so every section above prints the same numbers.');
  if (bugs) { console.log('Step 11-C acceptance: ' + bugs + ' BUG line(s) above'); process.exitCode = 1; }
}

run();
