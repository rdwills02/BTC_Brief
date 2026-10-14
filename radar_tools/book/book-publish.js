/* radar_tools/book/book-publish.js — item 52b D: lease-protected rolling publisher + main-repo archive appender. Advisory; never touches main except book-archive/ (normal push, stale rejected).
 * ROLLING (display window, history disposable): rdwills02/BTC_Brief-data, branch `rolling`. Every publish builds a PARENTLESS commit explicitly (git write-tree + commit-tree, no -p) holding the whole window tree and pushes it with
 *   git push --force-with-lease=refs/heads/rolling:<observed-sha> <remote> <commit>:refs/heads/rolling
 * On rejection: re-fetch the NEW tree, re-apply ONLY this writer's dataset files, keep every other dataset, reject older per-dataset versions (version = batch/slot time), rebuild the parentless commit, retry (max 3) with the new expected SHA.
 * Never force without a lease; never touches main or any tag. Hosted-storage reclamation of unreachable objects is NOT claimed: the guarantee is a bounded reachable rolling tree (28-day window compactor).
 * ARCHIVE (research retention, authoritative): book-archive/<venue>/<YYYY-MM>.jsonl.gz in MAIN, one gzip member appended per batch (existing bytes never rewritten; verified), idempotent by batch id, normal push (a stale parent is rejected, then retried on a fresh clone). */
'use strict';
var cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
var DATASETS = 'meta/datasets.json', RETAIN_DAYS = 28;
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function scrub(s) { return String(s || '').replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@').replace(/x-access-token:[^@\s]+/g, 'x-access-token:***'); }
function git(args, o) {
  o = o || {};
  try { return cp.execFileSync('git', args, { cwd: o.cwd, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'radar-book-bot', GIT_AUTHOR_EMAIL: 'actions@github.com', GIT_COMMITTER_NAME: 'radar-book-bot', GIT_COMMITTER_EMAIL: 'actions@github.com' }, o.env || {}), encoding: o.buffer ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { var err = new Error('git ' + args[0] + ' failed: ' + scrub(String(e.stderr || e.message)).trim().slice(0, 400)); err.stderr = scrub(String(e.stderr || '')); err.status = e.status; throw err; }
}
function tmp(prefix) { return fs.mkdtempSync(path.join(process.env.BOOK_TMP || os.tmpdir(), prefix)); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* scratch */ } }
function walk(dir, base, out) { fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) { if (e.name === '.git') return; var p = path.join(dir, e.name); if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/')); }); return out; }
function pruneEmpty(dir) { fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) { if (e.isDirectory() && e.name !== '.git') { var p = path.join(dir, e.name); pruneEmpty(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p); } }); }
function observe(remote, branch) { var o = git(['ls-remote', remote, 'refs/heads/' + branch]).trim(); return o ? o.split(/\s+/)[0] : null; }
// fetch the current branch tip (shallow) into a fresh work dir; returns { dir, sha } (sha = the tip actually fetched = the lease value)
function checkoutTip(remote, branch, workRoot) {
  var dir = path.join(workRoot, 'w' + Math.random().toString(36).slice(2, 8)); fs.mkdirSync(dir); git(['init', '-q'], { cwd: dir });
  var tip = observe(remote, branch); if (!tip) return { dir: dir, sha: null };
  git(['fetch', '-q', '--depth', '1', remote, 'refs/heads/' + branch], { cwd: dir }); var sha = git(['rev-parse', 'FETCH_HEAD'], { cwd: dir }).trim(); git(['checkout', '-q', '-f', sha], { cwd: dir });
  return { dir: dir, sha: sha };
}
function readDatasets(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, DATASETS), 'utf8')); } catch (e) { return { schema: 1, datasets: {} }; } }
function stable(o) { return JSON.stringify(o, function (k, v) { if (v && typeof v === 'object' && !Array.isArray(v)) { var s = {}; Object.keys(v).sort().forEach(function (x) { s[x] = v[x]; }); return s; } return v; }, 1); }
function dateOf(p) { var m = /^book\/(?:kraken|coinbase)\/(\d{4}-\d{2}-\d{2})\//.exec(p); return m ? m[1] : null; }
/* publishRolling(opts):
 *   remote, branch ('rolling'), dataset: { name, version (ISO, sortable), files: { relPath: Buffer|string }, meta: { captureId, generationId, observedAt, schema, grid, codec, ... }, retain: { days, now } | null },
 *   maxRetries (3), hooks: { beforePush(ctx), afterBuild(ctx) } (tests) -> { status: 'published'|'noop'|'stale-rejected'|'conflict', sha, attempts, pruned } */
function publishRolling(opts) {
  var branch = opts.branch || 'rolling', ds = opts.dataset, max = opts.maxRetries == null ? 3 : opts.maxRetries, hooks = opts.hooks || {}, workRoot = tmp('bookpub-'), attempts = 0, last = null;
  var files = {}, hashes = {}; Object.keys(ds.files).forEach(function (p) { if (/^\/|\.\.|^\.git(\/|$)/.test(p) || p === DATASETS) throw new Error('refused path: ' + p); files[p] = Buffer.isBuffer(ds.files[p]) ? ds.files[p] : Buffer.from(ds.files[p]); hashes[p] = sha(files[p]); });
  try {
    for (; attempts < max + 1;) {
      attempts++;
      var tip = checkoutTip(opts.remote, branch, workRoot), dir = tip.dir, reg = readDatasets(dir), cur = reg.datasets[ds.name];
      if (cur && cur.version > ds.version) return { status: 'stale-rejected', sha: tip.sha, attempts: attempts, reason: 'dataset ' + ds.name + ' at ' + cur.version + ' is newer than ' + ds.version };
      if (cur && cur.version === ds.version) { if (stable(cur.hashes) === stable(hashes)) return { status: 'noop', sha: tip.sha, attempts: attempts }; return { status: 'conflict', sha: tip.sha, attempts: attempts, reason: 'same version, different content hashes' }; }
      Object.keys(files).forEach(function (p) { var f = path.join(dir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[p]); });
      var pruned = [];
      if (ds.retain) { var cut = new Date(new Date(ds.retain.now || Date.now()).getTime() - (ds.retain.days || RETAIN_DAYS) * 86400000).toISOString().slice(0, 10); walk(dir, dir, []).forEach(function (p) { var d = dateOf(p); if (d && d < cut) { fs.unlinkSync(path.join(dir, p)); pruned.push(p); } }); pruneEmpty(dir); }
      reg.datasets[ds.name] = Object.assign({}, ds.meta || {}, { version: ds.version, hashes: hashes, files: Object.keys(files).length, publishedFrom: tip.sha ? tip.sha.slice(0, 12) : null }); reg.schema = 1;
      fs.mkdirSync(path.join(dir, 'meta'), { recursive: true }); fs.writeFileSync(path.join(dir, DATASETS), stable(reg) + '\n');
      git(['add', '-A'], { cwd: dir }); var tree = git(['write-tree'], { cwd: dir }).trim();
      var commit = git(['commit-tree', tree, '-m', 'rolling ' + ds.name + ' ' + ds.version], { cwd: dir, env: isFinite(Date.parse(ds.version)) ? { GIT_AUTHOR_DATE: ds.version, GIT_COMMITTER_DATE: ds.version } : {} }).trim();   // NO -p: parentless
      if (git(['cat-file', '-p', commit], { cwd: dir }).split('\n').some(function (l) { return /^parent /.test(l); })) throw new Error('internal: commit has a parent');
      var ctx = { attempt: attempts, observedSha: tip.sha, commit: commit, dir: dir, remote: opts.remote }; if (hooks.afterBuild) hooks.afterBuild(ctx); if (hooks.beforePush) hooks.beforePush(ctx);
      try {
        git(['push', '-q', '--force-with-lease=refs/heads/' + branch + ':' + (tip.sha || ''), opts.remote, commit + ':refs/heads/' + branch], { cwd: dir });
        return { status: 'published', sha: commit, attempts: attempts, pruned: pruned.length, tree: tree };
      } catch (e) {
        last = e; if (!/stale info|rejected|fetch first|failed to push|cannot lock/i.test(e.stderr || e.message)) throw e;   // lease lost -> loop: fresh tree, re-apply only this writer's files
      }
    }
    throw new Error('lease retries exhausted (' + max + '): ' + (last && last.message));
  } finally { rmrf(workRoot); }
}
function readRollingFile(remote, relPath, branch) {
  var wr = tmp('bookread-'); try { var tip = checkoutTip(remote, branch || 'rolling', wr); if (!tip.sha) return null; var p = path.join(tip.dir, relPath); return fs.existsSync(p) ? fs.readFileSync(p) : null; } finally { rmrf(wr); }
}
function readRollingTree(remote, destDir, prefixes, branch) {   // copy selected prefixes of the tip into destDir (state hydration for the collector); returns file count
  var wr = tmp('bookread-'), n = 0; try { var tip = checkoutTip(remote, branch || 'rolling', wr); if (!tip.sha) return 0; walk(tip.dir, tip.dir, []).forEach(function (p) { if (prefixes.some(function (x) { return p === x || p.indexOf(x) === 0; })) { var d = path.join(destDir, p); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(tip.dir, p), d); n++; } }); return n; } finally { rmrf(wr); }
}
/* archiveAppend(opts): remote, branch ('main'), items: [{ venue, month 'YYYY-MM', batchId, line (string, one JSON object) }], maxRetries (3), hooks.beforePush(ctx)
 * -> { status: 'pushed'|'noop'|'conflict', added: n, skipped: n, attempts } */
function archiveAppend(opts) {
  var branch = opts.branch || 'main', max = opts.maxRetries == null ? 3 : opts.maxRetries, hooks = opts.hooks || {}, workRoot = tmp('bookarc-'), attempts = 0, last = null;
  opts.items.forEach(function (it) { if (!/^(kraken|coinbase)$/.test(it.venue) || !/^\d{4}-\d{2}$/.test(it.month)) throw new Error('refused archive target ' + it.venue + '/' + it.month); });
  try {
    for (; attempts < max + 1;) {
      attempts++;
      var dir = path.join(workRoot, 'c' + attempts); git(['clone', '-q', '--depth', '1', '--branch', branch, opts.remote, dir]);
      var added = 0, skipped = 0, touched = [];
      for (var i = 0; i < opts.items.length; i++) {
        var it = opts.items[i], rel = 'book-archive/' + it.venue + '/' + it.month + '.jsonl.gz', f = path.join(dir, rel), old = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0), text = old.length ? zlib.gunzipSync(old).toString('utf8') : '', hit = null;
        text.split('\n').forEach(function (l) { if (l && !hit) { try { var o = JSON.parse(l); if (o.batchId === it.batchId) hit = l; } catch (e) { /* skip */ } } });
        if (hit) { if (hit === it.line) { skipped++; continue; } return { status: 'conflict', added: added, skipped: skipped, attempts: attempts, reason: 'batch ' + it.batchId + ' already archived with different content' }; }
        var neu = Buffer.concat([old, zlib.gzipSync(Buffer.from(it.line + '\n', 'utf8'), { level: 9 })]);
        if (!neu.slice(0, old.length).equals(old)) throw new Error('internal: archive would rewrite existing bytes');
        fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, neu); touched.push(rel); added++;
      }
      if (!added) return { status: 'noop', added: 0, skipped: skipped, attempts: attempts };
      touched.forEach(function (r) { git(['add', '--', r], { cwd: dir }); });
      var changed = git(['diff', '--cached', '--name-only'], { cwd: dir }).trim().split('\n'); if (changed.some(function (c) { return c.indexOf('book-archive/') !== 0; })) throw new Error('refused: staged paths outside book-archive/: ' + changed.join(','));
      git(['commit', '-q', '-m', 'Book archive — ' + (opts.label || opts.items.map(function (x) { return x.batchId; }).join(', ').slice(0, 120))], { cwd: dir });
      if (hooks.beforePush) hooks.beforePush({ attempt: attempts, dir: dir, remote: opts.remote });
      try { git(['push', '-q', opts.remote, 'HEAD:refs/heads/' + branch], { cwd: dir }); return { status: 'pushed', added: added, skipped: skipped, attempts: attempts }; }   // NORMAL push: a stale parent is rejected
      catch (e) { last = e; if (!/rejected|fetch first|non-fast-forward|failed to push/i.test(e.stderr || e.message)) throw e; }
    }
    throw new Error('archive retries exhausted: ' + (last && last.message));
  } finally { rmrf(workRoot); }
}
function archiveLine(venue, slot, gzBuf, batch) { return JSON.stringify({ batchId: venue + '|' + slot, venue: venue, slot: slot, sha256: sha(gzBuf), batch: batch }); }
// ---- CLI ----
function urlWithToken(url, token) { return token ? url.replace(/^https:\/\//, 'https://x-access-token:' + token + '@') : url; }
function cli(argv) {
  var cmd = argv[0], a = argv.slice(1), arg = function (k, d) { var i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  var rollingRemote = urlWithToken(arg('--rolling', process.env.BOOK_ROLLING_URL || ''), process.env.DATA_REPO_TOKEN), mainRemote = urlWithToken(arg('--main', process.env.BOOK_MAIN_URL || ''), process.env.GITHUB_TOKEN);
  if (cmd === 'fetch-state') { var n = rollingRemote ? readRollingTree(rollingRemote, arg('--dest', '.rolling-state'), ['book/cadence.json', 'book/grids.json', 'news/']) : 0; console.log('book-publish: hydrated ' + n + ' state file(s)'); return 0; }
  if (cmd === 'publish') {
    var out = arg('--out', 'out'), pubFile = path.join(out, 'publication.json'); if (!fs.existsSync(pubFile)) { console.log('book-publish: no publication.json (collector produced nothing) - nothing to publish'); return 0; }
    var pub = JSON.parse(fs.readFileSync(pubFile, 'utf8')), files = {}, items = [];
    pub.batches.forEach(function (b) { var gz = fs.readFileSync(path.join(out, 'batches', b.path)); files[b.path] = gz; items.push({ venue: b.venue, month: pub.slot.slice(0, 7), batchId: b.venue + '|' + pub.slot, line: archiveLine(b.venue, pub.slot, gz, JSON.parse(zlib.gunzipSync(gz).toString('utf8'))) }); });
    ['cadence.json', 'grids.json'].forEach(function (f) { var p = path.join(out, 'state', 'book', f); if (fs.existsSync(p)) files['book/' + f] = fs.readFileSync(p); });
    var code = 0;
    if (mainRemote) { try { var r1 = archiveAppend({ remote: mainRemote, items: items, label: pub.slot }); console.log('book-publish: archive ' + r1.status + ' (' + r1.added + ' added, ' + r1.skipped + ' skipped)'); } catch (e) { console.log('book-publish: ARCHIVE FAILED - ' + scrub(e.message)); code = 2; } }
    if (rollingRemote) { try { var r2 = publishRolling({ remote: rollingRemote, dataset: { name: 'book', version: pub.slot, files: files, meta: { captureId: pub.meta.captureId, generationId: pub.meta.generationId, observedAt: pub.slot, schema: 2, grid: 2, codec: 1, cadenceVersion: pub.meta.cadenceVersion }, retain: { days: RETAIN_DAYS, now: pub.slot } } }); console.log('book-publish: rolling ' + r2.status + ' (attempts ' + r2.attempts + ')'); } catch (e) { console.log('book-publish: ROLLING FAILED - ' + scrub(e.message)); code = 2; } }
    return code;   // the workflow marks the step continue-on-error: advisory data can never fail a canonical capture
  }
  console.log('usage: book-publish.js fetch-state|publish [--out dir] [--rolling url] [--main url] [--dest dir]'); return 0;
}
module.exports = { publishRolling: publishRolling, archiveAppend: archiveAppend, archiveLine: archiveLine, readRollingFile: readRollingFile, readRollingTree: readRollingTree, observe: observe, scrub: scrub, sha: sha, DATASETS: DATASETS, RETAIN_DAYS: RETAIN_DAYS };
if (require.main === module) process.exit(cli(process.argv.slice(2)));
