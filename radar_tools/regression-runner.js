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
}

run();
