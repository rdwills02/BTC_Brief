#!/usr/bin/env node
/* radar_tools/provisional.js — Radar Provisional Visibility producer (item 41, Spec v0.1). Node 20, no dependencies beyond the repo modules.
 * Visibility only: it never writes a canonical file. It publishes a PROJECTION keyed to the canonical base generation, from the SAME adjudicator the daily capture uses
 * (orders-core adjudicateAll with opts.provisional), on COPIES of the canonical books, plus the append-only 5-minute evidence it observed (data/forward/evidence/).
 *   node radar_tools/provisional.js [--dry-run]
 * Outcomes (one stdout line + $GITHUB_STEP_SUMMARY): published | no-change | skipped-for-capture | discarded-stale | failed.
 * Writer protocol: record origin/main head H0 and CURRENT C0 at start; do all work in memory; before publication re-check (CURRENT, origin/main, capture runs in progress / queued);
 * any change -> DISCARD (nothing written). Plain `git push`, never a rebase, never a force; a rejected push -> reset --hard origin/main, discarded-stale, exit 0.
 * --dry-run: everything except writing files and publishing (prints the projection summary and per-pair coverage).
 * Env: GH_TOKEN + GITHUB_REPOSITORY (capture-run query), GITHUB_STEP_SUMMARY. Tests inject fs/git/fetch/clock through run(). */
'use strict';
const nodeFs = require('fs'), nodePath = require('path'), nodeCrypto = require('crypto'), nodeCp = require('child_process'), nodeVm = require('vm');

const BAR5 = 300, DAY = 86400, LIVE = { resting: 1, 'pending-unresolved': 1, 'cancel-pending': 1, open: 1 };
const PAIR_RE = /^[A-Z0-9]{3,20}$/;
const iso = sec => new Date(sec * 1000).toISOString();
const dateOfSec = sec => iso(sec).slice(0, 10);
const num = v => typeof v === 'number' && isFinite(v);

// ---- the capture.js evidence adapters, extracted from the SOURCE (one implementation: the producer and the daily capture fetch and parse identically) ----
function extractFns(src, headers) {
  function extract(header) {
    const i = src.indexOf(header); if (i < 0) throw new Error('not found in capture.js: ' + header);
    if (/^(var|const) /.test(header)) return src.slice(i, src.indexOf('\n', i) + 1);
    const j = src.indexOf('{', src.indexOf(')', i)); let d = 0, k = j;
    for (; k < src.length; k++) {
      const ch = src[k], nx = src[k + 1];
      if (ch === '/' && nx === '/') { k = src.indexOf('\n', k); continue; }
      if (ch === '"' || ch === "'") { const q = ch; k++; while (src[k] !== q) { if (src[k] === '\\') k++; k++; } continue; }
      if (ch === '`') { k++; while (src[k] !== '`') { if (src[k] === '\\') k++; k++; } continue; }
      if (ch === '/' && /[=(,:]\s*$/.test(src.slice(Math.max(0, k - 3), k))) { k++; while (src[k] !== '/') { if (src[k] === '\\') k++; k++; } continue; }
      if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) break; }
    }
    return src.slice(i, k + 1);
  }
  const ctx = { Math, JSON, Number, String, Array, Object, BigInt, isFinite, parseInt, Promise, Error };
  nodeVm.createContext(ctx);
  nodeVm.runInContext(headers.map(extract).join('\n') + '\nthis.api = { fwdFetchBars5, fwdFetchTradesSlice };', ctx);
  return ctx.api;
}
const ADAPTER_HEADERS = ['var FWD_BAR5', 'var FWD_TRADES_PAGE', 'var FWD_TRADES_MAX_PAGES', 'function fwdParseOhlc5(', 'async function fwdFetchBars5(', 'function fwdParseTrades(', 'async function fwdFetchTradesSlice('];

function stable(o) { return JSON.stringify(o); }
function sha(env, buf) { return env.crypto.createHash('sha256').update(buf).digest('hex'); }
function readJson(env, file) { try { return JSON.parse(env.fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeAtomic(env, file, text) { env.fs.mkdirSync(env.path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; env.fs.writeFileSync(tmp, text); env.fs.renameSync(tmp, file); }

// ---- retained evidence: data/forward/evidence/<pair>/<YYYY-MM-DD>.json (append-only) ----
function evFile(env, pair, date) { return env.path.join(env.dataDir, 'forward', 'evidence', pair, date + '.json'); }
function emptyEv(pair, date) { return { pair: pair, date: date, bars5: [], trades: [], coverage: [], cursors: { lastBarId: null, lastTradesToSec: null }, completeness: { bars: 0, gaps: 0, complete: true } }; }
function deriveMeta(f) {   // coverage / cursors / completeness are DERIVED from the retained bars and slices (recomputed, never authoritative)
  const ids = f.bars5.map(b => b.id).sort((a, b) => a - b), cov = [];
  ids.forEach(id => { const last = cov[cov.length - 1]; if (last && last.toSec === id) last.toSec = id + BAR5; else cov.push({ fromSec: id, toSec: id + BAR5, complete: true }); });
  f.trades.forEach(s => cov.push({ fromSec: s.fromSec, toSec: s.toSec, complete: s.complete === true, kind: 'trades' }));
  let gaps = 0; for (let i = 1; i < ids.length; i++) gaps += Math.max(0, (ids[i] - ids[i - 1]) / BAR5 - 1);
  f.coverage = cov; f.cursors = { lastBarId: ids.length ? ids[ids.length - 1] : null, lastTradesToSec: f.trades.length ? Math.max.apply(null, f.trades.map(s => s.toSec)) : null };
  f.completeness = { bars: ids.length, gaps: gaps, complete: gaps === 0 };
  return f;
}
// Loads every retained file of a pair from `fromDate` on (UTC dates), returns { files: {date: obj}, bars: Map(id -> bar), slices: [slice] }.
function loadEvidence(env, pair, fromSec, toSec) {
  const out = { files: {}, bars: new Map(), slices: [] };
  for (let d = Math.floor(fromSec / DAY) * DAY; d <= toSec; d += DAY) {
    const date = dateOfSec(d), f = readJson(env, evFile(env, pair, date)); if (!f) continue;
    out.files[date] = f;
    (f.bars5 || []).forEach(b => { if (!out.bars.has(b.id)) out.bars.set(b.id, b); });
    (f.trades || []).forEach(s => out.slices.push(s));
  }
  return out;
}
// Merges NEW closed bars / slices into the in-memory files; an existing bar or slice is never replaced. Returns the number of items added.
function mergeEvidence(env, ev, pair, bars, slices, nowMs) {
  let added = 0; const observed = new Date(nowMs).toISOString();
  const fileOf = date => ev.files[date] || (ev.files[date] = emptyEv(pair, date));
  bars.forEach(b => {
    if (ev.bars.has(b.id)) return;
    const rec = { id: b.id, open: b.open, high: b.high, low: b.low, close: b.close, firstObservedAt: observed };
    fileOf(dateOfSec(b.id)).bars5.push(rec); ev.bars.set(b.id, rec); added++;
  });
  slices.forEach(s => {
    const dup = ev.slices.some(x => x.fromSec === s.fromSec && x.toSec === s.toSec && x.complete === s.complete && (x.reason || null) === (s.reason || null) && (s.complete || x.trades.length === s.trades.length));
    if (dup) return;
    const rec = { fromSec: s.fromSec, toSec: s.toSec, complete: s.complete === true, reason: s.reason || null, trades: (s.trades || []).map(x => [x.t, x.p, x.n == null ? null : x.n]), firstObservedAt: observed };
    fileOf(dateOfSec(s.fromSec)).trades.push(rec); ev.slices.push(rec); added++;
  });
  Object.keys(ev.files).forEach(date => { ev.files[date].bars5.sort((a, b) => a.id - b.id); ev.files[date].trades.sort((a, b) => a.fromSec - b.fromSec || a.toSec - b.toSec); deriveMeta(ev.files[date]); });
  return added;
}
function slicesForEngine(ev) { return ev.slices.map(s => ({ fromSec: s.fromSec, toSec: s.toSec, complete: s.complete === true, reason: s.reason || undefined, trades: s.trades.map(x => ({ t: x[0], p: x[1], n: x[2] })) })); }

// ---- books ----
function bookOf(orders, accounts) { return { schemaVersion: orders.schemaVersion, orders: orders.orders, attempts: orders.attempts, seq: accounts.seq, accounts: accounts.accounts }; }
function liveOrders(book) { return book.orders.filter(o => LIVE[o.status]); }
// Where this order still needs evidence from: entry -> its cursor (or its current window start); a fill-day position -> its cursor / fill time; a later holding day -> the start of the next holding day.
function needFrom(o) {
  if (o.status === 'open') return o.hDone === 0 ? (o.cursorSec != null ? o.cursorSec : o.fill.tSec) : o.fill.dayId + o.hDone * DAY;
  if (o.cursorSec != null) return o.cursorSec;
  return o.dId + (o.w0 + o.eligibleDone) * DAY;
}

// ---- the whole pass ----
async function build(env, st) {
  const OC = env.OC, now = env.nowMs(), nowSec = Math.floor(now / 1000), warnings = [], pairs = {};
  const live = [];
  [['prod', st.prodBook], ['shadow', st.shadowBook]].forEach(([which, book]) => { if (book) liveOrders(book).forEach(o => live.push({ which, o })); });
  live.forEach(({ o }) => { if (o.pair && PAIR_RE.test(o.pair)) { const p = pairs[o.pair] || (pairs[o.pair] = { cgIds: {}, from: Infinity }); p.cgIds[o.cgId] = 1; p.from = Math.min(p.from, needFrom(o)); } else warnings.push('order ' + o.id + ': no usable Kraken pair id (' + o.pair + ')'); });
  const evByPair = {}, added = {};
  for (const pair of Object.keys(pairs).sort()) {   // 1. retained evidence, then new closed bars from Kraken (since the earliest need of the pair)
    const p = pairs[pair], from = Math.floor(p.from / BAR5) * BAR5, ev = evByPair[pair] = loadEvidence(env, pair, from, nowSec);
    const r = await env.api.fwdFetchBars5(env.fetchJson, pair, from - BAR5);
    if (!r.ok) { warnings.push('OHLC5 ' + pair + ': ' + r.error); added[pair] = 0; }
    else added[pair] = mergeEvidence(env, ev, pair, r.bars.filter(b => b.id + BAR5 <= nowSec - BAR5), [], now);
    await env.sleep(env.delayMs);
  }
  // 2. evidenceCutoffSec = the newest retained bar end that is at least 300 s old (a just-closed bar is not trusted until it has settled)
  let cut = 0; Object.keys(evByPair).forEach(pair => evByPair[pair].bars.forEach((b, id) => { if (id + BAR5 <= nowSec - BAR5 && id + BAR5 > cut) cut = id + BAR5; }));
  const cap = { kind: 'provisional', captureId: 'P-' + new Date(now).toISOString(), baseGenerationId: st.genId, baseCaptureId: st.baseCaptureId, evidenceCutoffSec: cut, inputCutoffSec: st.inputCutoffSec, date: st.date };
  const evBarsFor = book => { const out = {}; live.forEach(({ o }) => { if (book.orders.indexOf(o) < 0 || !evByPair[o.pair]) return; const ev = evByPair[o.pair]; out[o.cgId] = { candles: [], bars5: Array.from(ev.bars.values()).map(b => ({ id: b.id, open: b.open, high: b.high, low: b.low, close: b.close })).sort((a, b) => a.id - b.id), trades: slicesForEngine(ev) }; }); return out; };
  const adjud = (book, ev, needs) => OC.adjudicateAll(book, cap, ev, { needs: needs, provisional: true });
  // 3. needs loop (Trades for a touched straddling bar), each need fetched once per run; the pure adjudication is re-run until no new need appears
  const attempted = new Set(), books = {};
  for (let iter = 0; iter < 6; iter++) {
    const needs = []; books.prod = st.prodBook ? adjud(st.prodBook, evBarsFor(st.prodBook), needs) : null; books.shadow = st.shadowBook ? adjud(st.shadowBook, evBarsFor(st.shadowBook), needs) : null;
    const todo = needs.filter(n => n.kind === 'trades' && n.pair && evByPair[n.pair] && !attempted.has(n.pair + '|' + n.fromSec + '|' + n.toSec));
    if (!todo.length) break;
    for (const n of todo) {
      attempted.add(n.pair + '|' + n.fromSec + '|' + n.toSec);
      const sl = await env.api.fwdFetchTradesSlice(env.fetchJson, n.pair, n.fromSec, n.toSec, { nowSec: nowSec });
      if (!sl.complete) warnings.push('Trades ' + n.pair + ' [' + n.fromSec + ',' + n.toSec + '): ' + sl.reason);
      added[n.pair] = (added[n.pair] || 0) + mergeEvidence(env, evByPair[n.pair], n.pair, [], [sl], now);
      await env.sleep(env.delayMs);
    }
  }
  return { live, pairs, evByPair, added, cap, books, warnings, cut };
}

function markOf(ev, cut) { let best = null; ev.bars.forEach((b, id) => { if (id + BAR5 <= cut && (!best || id > best.id)) best = b; }); return best; }
function projectOrders(env, st, b) {
  const OC = env.OC, out = [];
  const order = { N0: 0, C1: 1, CTRL: 2, NZ: 3 };
  b.live.forEach(({ which, o }) => {
    const copy = (b.books[which] || { orders: [] }).orders.find(x => x.id === o.id); if (!copy) return;
    const ev = b.evByPair[o.pair], mark = ev ? markOf(ev, b.cut) : null, pr = copy.provisional || {};
    let unreal = null;
    if (copy.status === 'open' && copy.fill && mark) unreal = OC.notional(copy.Q, copy.lotsInv, mark.close) - (copy.fill.notionalCents + copy.fill.feeCents + copy.fill.frictionCents);
    out.push({ id: o.id, policyId: o.policyId, cgId: o.cgId, pair: o.pair, status: o.status, projected: {
      status: copy.status,
      fillAt: copy.fill ? copy.fill.tSec : null, fillPrice: copy.fill ? copy.fill.price : null, fillReason: copy.fill ? copy.fill.reason : null,
      exit: copy.exit ? { reason: copy.exit.reason, at: copy.exit.tSec, price: copy.exit.price } : null,
      markPrice: mark ? mark.close : null, markAt: mark ? mark.id + BAR5 : null,
      unrealisedCents: unreal, unrealisedLabel: unreal == null ? null : 'estimate',
      unresolvedIntervals: copy.unresolved ? [{ phase: copy.unresolved.phase, fromSec: copy.unresolved.fromSec, toSec: copy.unresolved.toSec, reason: copy.unresolved.reason }] : [],
      notYetObservedFrom: pr.notYetObservedFrom == null ? null : pr.notYetObservedFrom,
      windowsExhausted: pr.windowsExhausted === true, partialDay: pr.partialDay === true } });
  });
  out.sort((a, b) => (order[a.policyId] == null ? 9 : order[a.policyId]) - (order[b.policyId] == null ? 9 : order[b.policyId]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
function coverageOf(b) {
  const perPair = {};
  Object.keys(b.pairs).sort().forEach(pair => {
    const ev = b.evByPair[pair], from = Math.floor(b.pairs[pair].from / BAR5) * BAR5; let have = 0, gaps = 0;
    for (let t = from; t < b.cut; t += BAR5) { if (ev.bars.has(t)) have++; else gaps++; }
    perPair[pair] = { bars: have, gaps: gaps, complete: b.cut > from && gaps === 0 };
  });
  return { perPair: perPair };
}
function sameProjection(a, b) { if (!a || !b) return false; const x = Object.assign({}, a), y = Object.assign({}, b); delete x.producedAt; delete y.producedAt; return stable(x) === stable(y); }

// ---- publication helpers ----
function git(env, args) { return env.execFile('git', args, { cwd: env.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
async function captureRunning(env) {   // true when a capture.yml run is in_progress or queued; throws when it cannot be determined
  const repo = env.repo; if (!repo) throw new Error('GITHUB_REPOSITORY not set');
  for (const status of ['in_progress', 'queued']) {
    const j = await env.fetchJson('https://api.github.com/repos/' + repo + '/actions/workflows/capture.yml/runs?status=' + status + '&per_page=5', { headers: { Authorization: 'Bearer ' + env.token, Accept: 'application/vnd.github+json' } });
    if (j && (j.total_count > 0 || (j.workflow_runs && j.workflow_runs.length))) return true;
  }
  return false;
}

async function run(opts) {
  opts = opts || {};
  const env = Object.assign({ fs: nodeFs, path: nodePath, crypto: nodeCrypto, execFile: nodeCp.execFileSync, nowMs: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), delayMs: 300,
    root: nodePath.join(__dirname, '..'), repo: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN, dryRun: false, log: s => console.log(s), summary: process.env.GITHUB_STEP_SUMMARY }, opts);
  env.dataDir = env.dataDir || env.path.join(env.root, 'data');
  env.OC = env.OC || require(env.path.join(env.root, 'orders-core.js'));
  if (!env.fetchJson) env.fetchJson = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  if (!env.api) env.api = extractFns(env.fs.readFileSync(env.path.join(env.root, 'capture.js'), 'utf8'), ADAPTER_HEADERS);
  const result = { outcome: 'failed', genId: null, evidenceCutoffSec: null, covered: 0, incomplete: 0, reason: null, wrote: false };
  const finish = (outcome, reason) => {
    result.outcome = outcome; result.reason = reason || null;
    const line = 'provisional: ' + outcome + ' | base ' + (result.genId || '-') + ' | evidence to ' + (result.evidenceCutoffSec ? iso(result.evidenceCutoffSec) : '-') + ' | pairs covered ' + result.covered + ' incomplete ' + result.incomplete + (reason ? ' | ' + reason : '') + (env.dryRun ? ' | DRY RUN' : '');
    env.log(line);
    if (env.summary) { try { env.fs.appendFileSync(env.summary, '### Provisional projection\n\n' + line + '\n'); } catch (e) { /* summary is best effort */ } }
    return result;
  };
  try {
    const P = env.path.join(env.dataDir, 'forward');
    const C0 = readJson(env, env.path.join(P, 'CURRENT')); if (!C0 || !C0.generationId) return finish('no-change', 'no CURRENT generation');
    result.genId = C0.generationId;
    let H0 = null; try { H0 = git(env, ['rev-parse', 'HEAD']).trim(); } catch (e) { return finish('failed', 'git rev-parse HEAD: ' + e.message); }
    // capture already running: nothing to project against (the projection would be discarded anyway)
    if (!env.dryRun) { let running; try { running = await captureRunning(env); } catch (e) { return finish('failed', 'capture-run query: ' + e.message); } if (running) return finish('skipped-for-capture', 'a capture run is in progress or queued'); }
    // B1: the canonical generation, checksum-verified
    const gdir = env.path.join(P, 'gen-' + C0.generationId), chk = readJson(env, env.path.join(gdir, 'checksums.json')); if (!chk || !chk.files) return finish('failed', 'checksums.json unreadable for ' + C0.generationId);
    const read = rel => { try { const buf = env.fs.readFileSync(env.path.join(gdir, rel)); if (sha(env, buf) !== chk.files[rel]) throw new Error('checksum mismatch ' + rel); return JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error(rel + ': ' + e.message); } };
    const orders = read('orders.json'), accounts = read('accounts.json'), hasShadow = !!(chk.files['shadow/orders.json'] && chk.files['shadow/accounts.json']);
    const st = { genId: C0.generationId, baseCaptureId: C0.captureId || C0.generationId, date: C0.date, prodBook: bookOf(orders, accounts), shadowBook: null };
    if (hasShadow) { try { st.shadowBook = bookOf(read('shadow/orders.json'), read('shadow/accounts.json')); } catch (e) { /* an unreadable shadow generation file leaves production projected and is reported as a warning below */ st.shadowErr = e.message; } }
    st.inputCutoffSec = Math.floor(Date.parse(C0.date + 'T00:00:00Z') / 1000);   // the canonical capture's input cutoff = 00:00 UTC of its date
    const baseChecksums = { 'orders.json': chk.files['orders.json'], 'shadow/orders.json': chk.files['shadow/orders.json'] || null };
    const existingPath = env.path.join(P, 'provisional', C0.generationId + '.json'), existing = readJson(env, existingPath);
    const liveCount = liveOrders(st.prodBook).length + (st.shadowBook ? liveOrders(st.shadowBook).length : 0);
    let b = null, projection;
    if (!liveCount) {   // B2: no live orders -> an empty projection only if the existing one differs
      projection = { schemaVersion: 1, baseGenerationId: C0.generationId, baseCaptureId: st.baseCaptureId, baseChecksums: baseChecksums, evidenceCutoffSec: null, producedAt: new Date(env.nowMs()).toISOString(), orders: [], coverage: { perPair: {} }, warnings: st.shadowErr ? ['shadow orders unreadable: ' + st.shadowErr] : [] };
    } else {
      b = await build(env, st);
      result.evidenceCutoffSec = b.cut;
      const cov = coverageOf(b); Object.keys(cov.perPair).forEach(p => { if (cov.perPair[p].complete) result.covered++; else result.incomplete++; });
      const warnings = b.warnings.slice(); if (st.shadowErr) warnings.push('shadow orders unreadable: ' + st.shadowErr);
      Object.keys(cov.perPair).forEach(p => { if (!cov.perPair[p].complete) warnings.push('coverage incomplete for ' + p + ' (' + cov.perPair[p].gaps + ' missing 5-min bars before the cutoff)'); });
      projection = { schemaVersion: 1, baseGenerationId: C0.generationId, baseCaptureId: st.baseCaptureId, baseChecksums: baseChecksums, evidenceCutoffSec: b.cut || null, producedAt: new Date(env.nowMs()).toISOString(), orders: projectOrders(env, st, b), coverage: cov, warnings: warnings };
    }
    const evidenceAdded = b ? Object.keys(b.added).reduce((s, k) => s + (b.added[k] || 0), 0) : 0;
    const projChanged = !sameProjection(existing, projection);
    if (env.dryRun) { result.projection = projection; result.evidenceAdded = evidenceAdded; summarize(env, projection, b); return finish('no-change', 'dry-run: nothing written (projection ' + (projChanged ? 'would change' : 'unchanged') + ', ' + evidenceAdded + ' new evidence items)'); }
    if (!projChanged && !evidenceAdded) return finish('no-change');
    // B6: compare-and-discard BEFORE anything is written
    try { git(env, ['fetch', 'origin', 'main']); } catch (e) { return finish('failed', 'git fetch: ' + e.message); }
    const C1 = readJson(env, env.path.join(P, 'CURRENT')); let H1 = null; try { H1 = git(env, ['rev-parse', 'origin/main']).trim(); } catch (e) { return finish('failed', 'git rev-parse origin/main: ' + e.message); }
    if (!C1 || C1.generationId !== C0.generationId) return finish('discarded-stale', 'CURRENT moved ' + C0.generationId + ' -> ' + (C1 && C1.generationId));
    if (H1 !== H0) return finish('discarded-stale', 'origin/main moved ' + H0.slice(0, 8) + ' -> ' + H1.slice(0, 8));
    let running2; try { running2 = await captureRunning(env); } catch (e) { return finish('failed', 'capture-run query: ' + e.message); }
    if (running2) return finish('skipped-for-capture', 'a capture run started during the pass');
    // write: evidence (append-only files), the projection, the pointer; older projections removed
    if (b) Object.keys(b.evByPair).forEach(pair => Object.keys(b.evByPair[pair].files).forEach(date => { const f = b.evByPair[pair].files[date]; const text = JSON.stringify(f, null, 1) + '\n'; let cur = null; try { cur = env.fs.readFileSync(evFile(env, pair, date), 'utf8'); } catch (e) { cur = null; } if (cur !== text) writeAtomic(env, evFile(env, pair, date), text); }));
    writeAtomic(env, existingPath, JSON.stringify(projection, null, 1) + '\n');
    writeAtomic(env, env.path.join(P, 'PROVISIONAL'), JSON.stringify({ generationId: C0.generationId, producedAt: projection.producedAt, evidenceCutoffSec: projection.evidenceCutoffSec }, null, 1) + '\n');
    try { (env.fs.readdirSync(env.path.join(P, 'provisional')) || []).forEach(n => { if (/\.json$/.test(n) && n !== C0.generationId + '.json') env.fs.unlinkSync(env.path.join(P, 'provisional', n)); }); } catch (e) { /* directory just created */ }
    result.wrote = true;
    ['data/forward/provisional', 'data/forward/evidence', 'data/forward/PROVISIONAL'].forEach(pth => { try { git(env, ['add', '-A', '--', pth]); } catch (e) { /* a path that never existed and tracks nothing */ } });
    let quiet = true; try { git(env, ['diff', '--cached', '--quiet']); } catch (e) { quiet = false; }
    if (quiet) return finish('no-change');
    git(env, ['-c', 'user.name=radar-provisional-bot', '-c', 'user.email=actions@github.com', 'commit', '-m', 'Provisional — ' + new Date(env.nowMs()).toISOString() + ' (gen ' + C0.generationId + ', evidence to ' + (projection.evidenceCutoffSec ? iso(projection.evidenceCutoffSec) : 'n/a') + ')']);
    try { git(env, ['push', 'origin', 'HEAD:main']); }
    catch (e) { try { git(env, ['fetch', 'origin', 'main']); git(env, ['reset', '--hard', 'origin/main']); } catch (e2) { return finish('failed', 'push rejected and reset failed: ' + e2.message); } return finish('discarded-stale', 'push rejected (not a fast-forward); reset to origin/main'); }
    return finish('published');
  } catch (e) {
    return finish('failed', (e && e.message) || String(e));
  }
}
function summarize(env, projection, b) {
  env.log('projection: base ' + projection.baseGenerationId + ' | evidence to ' + (projection.evidenceCutoffSec ? iso(projection.evidenceCutoffSec) : 'n/a') + ' | orders ' + projection.orders.length);
  projection.orders.forEach(o => { const p = o.projected;
    env.log('  ' + o.id + ' [' + o.pair + '] canonical ' + o.status + ' -> ' + p.status + (p.fillAt != null ? ' | fill ' + iso(p.fillAt) + ' @ ' + p.fillPrice + ' (' + p.fillReason + ')' : '') + (p.exit ? ' | exit ' + p.exit.reason + ' ' + iso(p.exit.at) + ' @ ' + p.exit.price : '') +
      (p.markPrice != null ? ' | mark ' + p.markPrice + ' @ ' + iso(p.markAt) : '') + (p.unrealisedCents != null ? ' | unrealised ' + p.unrealisedCents + 'c (estimate)' : '') + (p.notYetObservedFrom ? ' | not yet observed from ' + iso(p.notYetObservedFrom) : '') + (p.unresolvedIntervals.length ? ' | unresolved ' + p.unresolvedIntervals.length : '')); });
  Object.keys(projection.coverage.perPair).forEach(k => { const c = projection.coverage.perPair[k]; env.log('  coverage ' + k + ': bars ' + c.bars + ' gaps ' + c.gaps + ' ' + (c.complete ? 'complete' : 'INCOMPLETE')); });
  projection.warnings.forEach(w => env.log('  warning: ' + w));
}

module.exports = { run, extractFns, ADAPTER_HEADERS, loadEvidence, mergeEvidence, deriveMeta, needFrom, coverageOf };
if (require.main === module) {
  run({ dryRun: process.argv.indexOf('--dry-run') >= 0 }).then(r => { process.exitCode = r.outcome === 'failed' ? 1 : 0; }).catch(e => { console.error('provisional: failed | ' + (e && e.message)); process.exitCode = 1; });
}
