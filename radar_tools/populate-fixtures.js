/* radar_tools/populate-fixtures.js — Step 5 (Harness), Remediation spec 2026-09-22.
 *
 * Copies repo-root data/ into radar_tools/fixtures/data/ — a gitignored local snapshot (see
 * radar_tools/.gitignore). This is the file the regression-runner actually reads; data/ itself
 * is live (capture.js appends to it continuously) and is never read directly by the runner.
 *
 * Run this once after cloning (or whenever you deliberately want to re-baseline the fixture
 * snapshot), then run build-manifest.js to pin it. Re-running this file is a DELIBERATE
 * re-baseline, not routine maintenance — it changes what regression-runner.js measures against.
 *
 * Run: node populate-fixtures.js   (from inside radar_tools/, at repo root alongside data/)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'data');
const DEST = path.join(__dirname, 'fixtures', 'data');

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else if (entry.name.endsWith('.json')) fs.copyFileSync(s, d);
  }
}

function run() {
  if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
  }
  copyRecursive(SRC, DEST);

  let commitSha = null;
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    console.log('WARNING: could not read git HEAD (' + e.message + '). ' +
      'Pass the commit sha manually to build-manifest.js, or fix this before pinning — ' +
      'a manifest without a real pinnedCommit is not a valid pin.');
  }
  fs.writeFileSync(path.join(__dirname, 'fixtures', '.pinned-commit'), (commitSha || '') + '\n');
  console.log('Fixtures populated at radar_tools/fixtures/data/. Pinned commit: ' + (commitSha || '(unknown — see warning above)'));
  console.log('Next: run build-manifest.js to generate manifest.json.');
}

run();
