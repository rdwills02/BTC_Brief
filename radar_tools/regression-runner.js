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

run();
