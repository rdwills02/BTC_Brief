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


// Step 8 E3 (Remediation spec, 2026-09-21/22; restage 2026-09-23): bullEngulfingResearch
// tightening. Two comparisons, both over the SAME frozen coin universe/dates
// runStep7Acceptance already establishes (latest grid date for 4d-grid, latest daily date -
// the frozen 9/16 capture in this fixture snapshot - for 1d):
//   1. OLD (channel-core.orig.js, pinned at this step's pre-diff blob) vs NEW (channel-core.js,
//      this diff) bullEngulf field under research mode, per pass - the actual before/after this
//      diff makes. Every row that changes is listed and labeled E3 (this is the only spec item
//      touching bullEngulf, so there is nothing else it could be attributed to).
//   2. Flag-off vs research bullEngulf under NEW alone, 1d pass only - the population-delta
//      observation the plan asked for, not a target to tune toward.
function runStep8E3Acceptance(current, grids, gridCaches, dailyCaches) {
  const orig = require(path.join(__dirname, 'channel-core.orig.js'));
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

  console.log('\n=== Step 8 E3 acceptance (bullEngulfingResearch tightening) — 1d on ohlcDaily (frozen 9/16 capture), 4d-grid on ohlc ===');
  console.log('Latest grid date: ' + latestGridDate + ' | latest daily date: ' + latestDailyDate + ' | coin universe: ' + coins.length);

  function slice(cgId, tf) {
    const src = (tf === '1d') ? dailyCaches[cgId] : gridCaches[cgId];
    if (!src) return null;
    const D = (tf === '1d') ? latestDailyDate : latestGridDate;
    return sliceToDate(src, D);
  }

  console.log('\n--- 1. OLD vs NEW bullEngulf (research mode), per pass — every changed row attributed to E3 ---');
  for (const tf of ['1d', '4d-grid']) {
    let oldTrue = 0, newTrue = 0, checked = 0;
    const changed = [];
    for (const cgId of coins) {
      const s = slice(cgId, tf);
      if (!s || s.length < 30) continue;
      let oldR = null, newR = null;
      try { oldR = orig.detectChannel(s, undefined, { cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      try { newR = current.detectChannel(s, undefined, { cgId, timeframe: tf, source: 'fixture', research: true }); } catch (e) { /* null */ }
      const oldHit = !!(oldR && oldR.bullEngulf);
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
  // for. Caught by checking the printed date rather than assuming section 1's derivation
  // applies here too.
  const FROZEN_916_DATE = '2026-09-16';
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

run();
