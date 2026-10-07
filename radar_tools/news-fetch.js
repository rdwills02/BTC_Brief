#!/usr/bin/env node
/* radar_tools/news-fetch.js — Radar Headlines Feed producer (item 31, spec v0). Node 20, no dependencies.
 * Reads the coin universe from ./data/latest-daily.json (checkout, not network), fetches Google News RSS per coin (sequential, 150 ms apart,
 * 10 s timeout, one retry), merges into data/news/headlines.json (title-normalised de-dup per coin, firstSeenAt kept, 7-day prune, 15/coin cap)
 * and writes it deterministically. Advisory display data only — nothing here feeds detection, gates, orders or the cohort.
 * Exit code is ALWAYS 0: a failed coin keeps its earlier items and is listed in coverage.failed; an unreadable universe writes nothing.
 * generatedAt = the time of THIS run, always (the monitor's freshness signal). lastChangedAt = the last run whose items changed. runSeq = monotonic run counter.
 * An unchanged-items run still rewrites the file, but the diff is only the generatedAt and runSeq lines.
 * Env (tests / local runs only): NEWS_ROOT (repo root), NEWS_RSS_BASE (default Google News search URL), NEWS_DELAY_MS, NEWS_NOW (ISO). */
'use strict';
const fs = require('fs'), path = require('path');
const RSS_BASE = 'https://news.google.com/rss/search';
const CFG = { DELAY_MS: 150, TIMEOUT_MS: 10000, RETRY_WAIT_MS: 500, RETENTION_MS: 7 * 86400e3, CAP: 15, MIN_CAP: 3, MAX_BYTES: 300000 };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (m, e) {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
    var n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch (x) { return m; }
  });
}
function tagText(block, tag) {   // first <tag ...>text</tag>; CDATA unwrapped; entities decoded once; null when absent
  var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block); if (!m) return null;
  var t = m[1].trim(), c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  return (c ? c[1] : decodeEntities(t)).trim();
}
function isoOrNull(s) { var t = s ? Date.parse(s) : NaN; return isFinite(t) ? new Date(t).toISOString() : null; }
function parseRss(xml) {   // -> { ok, items:[{title, link, source, publishedAt}] }; ok=false when the body is not an RSS channel (format change / error page)
  if (typeof xml !== 'string' || !/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) return { ok: false, items: [] };
  var items = [], re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi, m;
  while ((m = re.exec(xml))) {
    var b = m[1], title = tagText(b, 'title'), link = tagText(b, 'link'), src = tagText(b, 'source'), pub = tagText(b, 'pubDate');
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    if (src && title.length > src.length + 3 && title.slice(-(src.length + 3)) === ' - ' + src) title = title.slice(0, -(src.length + 3)).trim();
    if (!title) continue;
    items.push({ title: title, link: link, source: src || null, publishedAt: isoOrNull(pub) });
  }
  return { ok: true, items: items };
}
function normTitle(t) { return String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function buildQuery(coin, overrides) {
  if (overrides && typeof overrides[coin.cgId] === 'string' && overrides[coin.cgId].trim()) return overrides[coin.cgId].trim();
  return '"' + String(coin.name || coin.symbol || coin.cgId).replace(/"/g, '') + '" ' + String(coin.symbol || '').toUpperCase() + ' crypto when:1d';
}
function effTime(it) { var t = Date.parse(it.publishedAt || it.firstSeenAt); return isFinite(t) ? t : 0; }
function order(a, b) { return effTime(b) - effTime(a) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0); }
// merge previous items with fetched ones for one coin; returns the pruned, ordered, capped list (cap applied by the caller's size guard)
function mergeCoin(prevItems, fetched, nowMs, firstSeenIso) {
  var by = {};
  (prevItems || []).forEach(function (it) { if (it && it.title) by[normTitle(it.title)] = { title: it.title, link: it.link, source: it.source == null ? null : it.source, publishedAt: it.publishedAt || null, firstSeenAt: it.firstSeenAt }; });
  (fetched || []).forEach(function (it) {
    var k = normTitle(it.title), o = by[k];
    if (o) { if (!o.publishedAt && it.publishedAt) o.publishedAt = it.publishedAt; }   // first-seen entry wins; only a missing time is filled in
    else by[k] = { title: it.title, link: it.link, source: it.source, publishedAt: it.publishedAt, firstSeenAt: firstSeenIso };
  });
  return Object.keys(by).map(function (k) { return by[k]; }).filter(function (it) { return nowMs - effTime(it) <= CFG.RETENTION_MS; }).sort(order);
}
function render(meta, coinsObj, cap) {   // deterministic text: header lines, then one line per coin (coins sorted by cgId)
  var ids = Object.keys(coinsObj).sort(), lines = ids.map(function (id) {
    var c = coinsObj[id]; return JSON.stringify(id) + ':' + JSON.stringify({ symbol: c.symbol, items: c.items.slice(0, cap) });
  });
  return '{\n"schemaVersion":1,\n"generatedAt":' + JSON.stringify(meta.generatedAt) + ',\n"lastChangedAt":' + JSON.stringify(meta.lastChangedAt) + ',\n"runSeq":' + meta.runSeq + ',\n"source":"google-news-rss",\n"coverage":' + JSON.stringify(meta.coverage) + ',\n"coins":{\n' + lines.join(',\n') + '\n}\n}\n';
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function fetchOnce(fetchFn, url, timeoutMs) {
  var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, timeoutMs);
  try {
    var res = await fetchFn(url, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; RadarNewsFetch/1.0)', 'accept': 'application/rss+xml, application/xml, text/xml' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var parsed = parseRss(await res.text()); if (!parsed.ok) throw new Error('not an RSS channel');
    return parsed.items;
  } finally { clearTimeout(timer); }
}
async function fetchCoin(fetchFn, url, o) {
  try { return { ok: true, items: await fetchOnce(fetchFn, url, o.timeoutMs) }; }
  catch (e1) {
    await sleep(o.retryWaitMs);
    try { return { ok: true, items: await fetchOnce(fetchFn, url, o.timeoutMs) }; }
    catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
  }
}
async function run(opts) {
  opts = opts || {};
  var root = opts.root, fetchFn = opts.fetchFn || fetch, base = opts.rssBase || RSS_BASE, delay = opts.delayMs == null ? CFG.DELAY_MS : opts.delayMs;
  var now = opts.now ? new Date(opts.now) : new Date(), nowMs = now.getTime(), nowIso = now.toISOString();
  var out = { wrote: false, bytes: 0, coverage: null, universe: 0 };
  var universe; try { universe = JSON.parse(fs.readFileSync(path.join(root, 'data', 'latest-daily.json'), 'utf8')).coins; } catch (e) { universe = null; }
  if (!Array.isArray(universe) || !universe.length) { console.log('news-fetch: universe unreadable (data/latest-daily.json) - nothing written'); return out; }
  universe = universe.filter(function (c) { return c && c.cgId; }).sort(function (a, b) { return a.cgId < b.cgId ? -1 : a.cgId > b.cgId ? 1 : 0; });
  var overrides = {}; try { overrides = JSON.parse(fs.readFileSync(opts.queriesPath || path.join(__dirname, 'news-queries.json'), 'utf8')) || {}; } catch (e) { overrides = {}; }
  var file = path.join(root, 'data', 'news', 'headlines.json'), prevText = null, prev = null;
  try { prevText = fs.readFileSync(file, 'utf8'); prev = JSON.parse(prevText); } catch (e) { prevText = null; prev = null; }
  var prevCoins = prev && prev.coins && typeof prev.coins === 'object' ? prev.coins : {};
  var coinsObj = {}, failed = [], okN = 0;
  for (var i = 0; i < universe.length; i++) {
    var c = universe[i], q = buildQuery(c, overrides), url = base + '?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';
    var r = await fetchCoin(fetchFn, url, { timeoutMs: opts.timeoutMs || CFG.TIMEOUT_MS, retryWaitMs: opts.retryWaitMs == null ? CFG.RETRY_WAIT_MS : opts.retryWaitMs });
    var prevItems = prevCoins[c.cgId] && Array.isArray(prevCoins[c.cgId].items) ? prevCoins[c.cgId].items : [];
    if (r.ok) okN++; else { failed.push(c.cgId); console.log('news-fetch: ' + c.cgId + ' failed - ' + r.error); }
    coinsObj[c.cgId] = { symbol: String(c.symbol || '').toUpperCase(), items: mergeCoin(prevItems, r.ok ? r.items : [], nowMs, nowIso) };
    if (i < universe.length - 1 && delay > 0) await sleep(delay);
  }
  var coverage = { coins: universe.length, ok: okN, failed: failed };
  var prevSeq = prev && Number.isInteger(prev.runSeq) && prev.runSeq >= 0 ? prev.runSeq : 0, runSeq = prevSeq + 1;
  var prevChanged = prev && typeof prev.lastChangedAt === 'string' ? prev.lastChangedAt : (prev && typeof prev.generatedAt === 'string' ? prev.generatedAt : null);   // legacy file: generatedAt was the change time
  function build(changed) { return render({ generatedAt: nowIso, lastChangedAt: changed, runSeq: runSeq, coverage: coverage }, coinsObj, cap); }
  function coinsBlock(t) { var i = typeof t === 'string' ? t.indexOf('\n"coins":{\n') : -1; return i < 0 ? null : t.slice(i); }   // items only: header fields (incl. coverage) are excluded from the change test
  var cap = CFG.CAP, text = build(prevChanged || nowIso);
  while (Buffer.byteLength(text) > CFG.MAX_BYTES && cap > CFG.MIN_CAP) { cap--; text = build(prevChanged || nowIso); }   // size guard: shrink the per-coin cap uniformly
  var changed = coinsBlock(text) !== coinsBlock(prevText) || !prevChanged;
  if (changed) text = build(nowIso);                       // items changed (or first run) -> stamp the change time
  out.coverage = coverage; out.universe = universe.length; out.cap = cap; out.itemsChanged = changed; out.runSeq = runSeq;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); out.wrote = true; out.bytes = Buffer.byteLength(text);
  return out;
}
module.exports = { parseRss: parseRss, normTitle: normTitle, buildQuery: buildQuery, mergeCoin: mergeCoin, render: render, run: run, CFG: CFG, decodeEntities: decodeEntities };
if (require.main === module) {
  var root = process.env.NEWS_ROOT ? require('path').resolve(process.env.NEWS_ROOT) : require('path').join(__dirname, '..');
  run({ root: root, rssBase: process.env.NEWS_RSS_BASE || undefined, delayMs: process.env.NEWS_DELAY_MS != null ? +process.env.NEWS_DELAY_MS : undefined, now: process.env.NEWS_NOW || undefined })
    .then(function (o) { console.log('news-fetch: coins ' + o.universe + ', coverage ok ' + (o.coverage ? o.coverage.ok : 0) + '/' + (o.coverage ? o.coverage.coins : 0) + ', failed ' + (o.coverage ? o.coverage.failed.length : 0) + ', bytes ' + o.bytes + ', cap ' + (o.cap || 0) + ', ' + (o.wrote ? 'wrote data/news/headlines.json (runSeq ' + o.runSeq + ', items ' + (o.itemsChanged ? 'changed' : 'unchanged') + ')' : 'nothing written')); })
    .catch(function (e) { console.log('news-fetch: unexpected error - ' + (e && e.message)); })
    .then(function () { process.exit(0); });
}
