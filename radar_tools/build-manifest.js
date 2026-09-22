/* radar_tools/build-manifest.js — Step 5 (Harness), Remediation spec 2026-09-22.
 * Rewritten per Ryan's "Review of Step 5 rerun": the runner must read a gitignored local
 * fixture snapshot, not live data/, and the manifest must pin the stable detector's own blob
 * alongside the data files — not just hash data.
 *
 * Hashes every file under radar_tools/fixtures/data/ (populated by populate-fixtures.js — run
 * that first) and writes radar_tools/manifest.json with:
 *   - pinnedCommit: the repo commit the fixture snapshot was taken from (from
 *     fixtures/.pinned-commit, written by populate-fixtures.js)
 *   - stableDetectorBlob: the git-blob sha1 of ../channel-core.stable.js AT THE TIME this
 *     manifest is generated — this is what regression-runner.js checks channel-core.stable.js
 *     against before every run. If channel-core.stable.js changes (correctly or by accident)
 *     without this manifest being regenerated, the runner aborts rather than silently running
 *     against a baseline that no longer matches what was reviewed and approved.
 *   - files: path + git-blob sha1 + size for every fixture data file.
 *
 * radar_tools/fixtures/ is gitignored (see radar_tools/.gitignore) — it is never pushed. This
 * manifest.json IS pushed; it is the pin, not a duplicate of the 44MB it describes.
 *
 * Run: node build-manifest.js   (from inside radar_tools/, after populate-fixtures.js)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES_DATA_DIR = path.join(__dirname, 'fixtures', 'data');
const PINNED_COMMIT_FILE = path.join(__dirname, 'fixtures', '.pinned-commit');
const STABLE_DETECTOR_PATH = path.join(REPO_ROOT, 'channel-core.stable.js');

function blobSha1(filePath) {
  const data = fs.readFileSync(filePath);
  const header = Buffer.from('blob ' + data.length + '\0');
  return crypto.createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
}

function run() {
  if (!fs.existsSync(FIXTURES_DATA_DIR)) {
    throw new Error('radar_tools/fixtures/data/ not found — run populate-fixtures.js first.');
  }
  if (!fs.existsSync(PINNED_COMMIT_FILE)) {
    throw new Error('radar_tools/fixtures/.pinned-commit not found — run populate-fixtures.js first.');
  }
  const pinnedCommit = fs.readFileSync(PINNED_COMMIT_FILE, 'utf8').trim();
  if (!pinnedCommit) {
    throw new Error('fixtures/.pinned-commit is empty — populate-fixtures.js could not read git HEAD. ' +
      'A manifest without a real pinned commit is not a valid pin; fix that before generating one.');
  }
  if (!fs.existsSync(STABLE_DETECTOR_PATH)) {
    throw new Error('../channel-core.stable.js not found at repo root.');
  }
  const stableDetectorBlob = blobSha1(STABLE_DETECTOR_PATH);

  const files = [];
  walk(FIXTURES_DATA_DIR, files);
  files.sort();

  const manifest = {
    generatedAt: new Date().toISOString(),
    note: 'Pinned fixture manifest for the Step 5 (Harness) regression guard. fixtures/data/ ' +
      'is gitignored and never pushed — this file is the pin. regression-runner.js re-hashes ' +
      'every file below and re-hashes ../channel-core.stable.js against stableDetectorBlob ' +
      'before running; either mismatch is a hard abort, no automatic re-pin.',
    pinnedCommit: pinnedCommit,
    stableDetectorBlob: stableDetectorBlob,
    fileCount: files.length,
    files: files.map(f => {
      const rel = path.relative(path.join(__dirname, 'fixtures'), f).split(path.sep).join('/');
      const stat = fs.statSync(f);
      return { path: rel, sha1: blobSha1(f), size: stat.size };
    })
  };
  fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('wrote manifest.json: ' + manifest.fileCount + ' fixture files, pinnedCommit=' +
    pinnedCommit.slice(0, 12) + ', stableDetectorBlob=' + stableDetectorBlob.slice(0, 12));
}

run();
