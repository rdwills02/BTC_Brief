/* radar_tools/news-fetch-tests.js — fixtures for news-fetch.js (spec section 7-B). No network: every fetch is an injected function. node news-fetch-tests.js [path/to/news-fetch.js] */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const NF = require(path.resolve(process.argv[2] || path.join(__dirname, 'news-fetch.js')));
let pass = 0, total = 0;
function ok(c, n) { total++; if (c) pass++; else console.log('FAIL', n); }
const NOW = '2026-10-05T12:00:00.000Z', NOWMS = Date.parse(NOW), H = 3600e3, D = 86400e3;
const rfc = ms => new Date(NOWMS + ms).toUTCString();
function rss(items) { return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>' + items.map(i => '<item><title>' + i.t + '</title><link>' + (i.l || 'https://news.google.com/rss/articles/' + encodeURIComponent(i.t)) + '</link>' + (i.p == null ? '' : '<pubDate>' + i.p + '</pubDate>') + (i.s ? '<source url="https://x.example">' + i.s + '</source>' : '') + '</item>').join('') + '</channel></rss>'; }
const resp = body => ({ ok: true, status: 200, text: async () => body });
function mkRoot(coins, prev) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newsfetch-')); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'latest-daily.json'), JSON.stringify({ coins: coins }));
  if (prev) { fs.mkdirSync(path.join(root, 'data', 'news'), { recursive: true }); fs.writeFileSync(path.join(root, 'data', 'news', 'headlines.json'), prev); }
  return root;
}
const readOut = root => { const f = path.join(root, 'data', 'news', 'headlines.json'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
const COINS = [{ cgId: 'monero', symbol: 'xmr', name: 'Monero' }, { cgId: 'sky', symbol: 'sky', name: 'Sky' }, { cgId: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }];
const base = { rssBase: 'http://fixture.invalid/rss', delayMs: 0, retryWaitMs: 0, now: NOW };

(async () => {
  // ---- RSS parse ----
  let p = NF.parseRss(rss([{ t: 'Monero hits high - Reuters', p: 'Sun, 04 Oct 2026 10:00:00 GMT', s: 'Reuters' }]));
  ok(p.ok && p.items.length === 1 && p.items[0].title === 'Monero hits high' && p.items[0].source === 'Reuters' && p.items[0].publishedAt === '2026-10-04T10:00:00.000Z', 'parse: " - Source" suffix stripped when <source> present; pubDate -> ISO');
  p = NF.parseRss(rss([{ t: 'Title with - dash and no source element' }]));
  ok(p.items[0].title === 'Title with - dash and no source element' && p.items[0].source === null && p.items[0].publishedAt === null, 'parse: suffix kept when no <source>; missing pubDate -> null');
  p = NF.parseRss(rss([{ t: 'Different - Other', s: 'Reuters', p: 'garbage date' }]));
  ok(p.items[0].title === 'Different - Other' && p.items[0].publishedAt === null, 'parse: suffix not equal to <source> is kept; unparsable pubDate -> null');
  p = NF.parseRss(rss([{ t: 'A &amp; B &lt;fork&gt; &quot;up&quot; &#39;x&#39; &#x41;', s: 'S &amp; Co' }]));
  ok(p.items[0].title === 'A & B <fork> "up" \'x\' A' && p.items[0].source === 'S & Co', 'parse: entities decoded (named, decimal, hex)');
  p = NF.parseRss('<rss><channel><item><title><![CDATA[Raw <b>&amp; text - Wire]]></title><link>https://a.example/1</link><source>Wire</source></item></channel></rss>');
  ok(p.items[0].title === 'Raw <b>&amp; text', 'parse: CDATA content taken verbatim, then suffix stripped');
  p = NF.parseRss(rss([{ t: 'No link item', l: 'ftp://bad' }, { t: 'Good', l: 'https://ok.example/x' }]));
  ok(p.items.length === 1 && p.items[0].title === 'Good', 'parse: item without an http(s) link dropped');
  ok(NF.parseRss('<html>blocked</html>').ok === false && NF.parseRss('').ok === false && NF.parseRss(null).ok === false, 'parse: non-RSS body -> ok=false');
  ok(NF.parseRss('<rss><channel><title>t</title></channel></rss>').ok === true && NF.parseRss('<rss><channel></channel></rss>').items.length === 0, 'parse: valid empty channel -> ok, zero items');

  // ---- queries: default and override ----
  ok(NF.buildQuery(COINS[0], {}) === '"Monero" XMR crypto when:1d', 'query default: "<name>" <TICKER> crypto when:1d');
  const seen = [];
  let root = mkRoot(COINS), o = await NF.run(Object.assign({}, base, { root: root, queriesPath: path.join(root, 'q.json'), fetchFn: async (u) => { seen.push(decodeURIComponent(u.split('q=')[1].split('&')[0])); return resp(rss([])); } }));
  ok(seen.includes('"Monero" XMR crypto when:1d') && seen.includes('"Bitcoin" BTC crypto when:1d'), 'run: default queries used');
  fs.writeFileSync(path.join(root, 'q.json'), JSON.stringify({ sky: '"Sky Protocol" SKY crypto when:1d' })); seen.length = 0;
  await NF.run(Object.assign({}, base, { root: root, queriesPath: path.join(root, 'q.json'), fetchFn: async (u) => { seen.push(decodeURIComponent(u.split('q=')[1].split('&')[0])); return resp(rss([])); } }));
  ok(seen.includes('"Sky Protocol" SKY crypto when:1d') && !seen.includes('"Sky" SKY crypto when:1d'), 'override query used for sky');
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, 'news-queries.json'), 'utf8'));
  ok(['sky', 'fetch-ai', 'okb', 'morpho', 'hyperliquid', 'aster-2'].every(k => typeof shipped[k] === 'string' && shipped[k].length > 10), 'shipped news-queries.json has the six known collisions, comment-free JSON');
  ok(seen.every(u => true) && /&hl=en-US&gl=US&ceid=US:en$/.test(await (async () => { let url; await NF.run(Object.assign({}, base, { root: mkRoot(COINS.slice(0, 1)), fetchFn: async (u) => { url = u; return resp(rss([])); } })); return url; })()), 'run: request URL carries hl=en-US&gl=US&ceid=US:en');

  // ---- output shape, order, determinism ----
  const feed = { monero: rss([{ t: 'Older item - A', p: rfc(-30 * H), s: 'A' }, { t: 'Newest item - B', p: rfc(-1 * H), s: 'B' }, { t: 'Same time b - C', p: rfc(-5 * H), s: 'C' }, { t: 'Same time a - C', p: rfc(-5 * H), s: 'C' }]), sky: rss([]), bitcoin: rss([{ t: 'No date item' }]) };
  const fetchFeed = async (u) => { const q = decodeURIComponent(u.split('q=')[1].split('&')[0]); const k = /Monero/.test(q) ? 'monero' : /Sky/.test(q) ? 'sky' : 'bitcoin'; return resp(feed[k]); };
  root = mkRoot(COINS); o = await NF.run(Object.assign({}, base, { root: root, fetchFn: fetchFeed }));
  let t1 = readOut(root), j = JSON.parse(t1);
  ok(j.schemaVersion === 1 && j.source === 'google-news-rss' && j.generatedAt === NOW && j.coverage.coins === 3 && j.coverage.ok === 3 && j.coverage.failed.length === 0, 'output: header + coverage');
  ok(JSON.stringify(Object.keys(j.coins)) === JSON.stringify(['bitcoin', 'monero', 'sky']), 'output: coins sorted by cgId');
  ok(j.coins.monero.symbol === 'XMR' && j.coins.monero.items.map(i => i.title).join('|') === 'Newest item|Same time a|Same time b|Older item', 'output: items by publishedAt desc then title');
  ok(Object.keys(j.coins.monero.items[0]).join() === 'title,link,source,publishedAt,firstSeenAt' && j.coins.monero.items[0].firstSeenAt === NOW, 'output: item fields');
  ok(j.coins.bitcoin.items[0].publishedAt === null && j.coins.bitcoin.items[0].firstSeenAt === NOW, 'output: missing pubDate -> publishedAt null, firstSeenAt now');
  const mt = fs.statSync(path.join(root, 'data', 'news', 'headlines.json')).mtimeMs;
  await NF.run(Object.assign({}, base, { root: root, fetchFn: fetchFeed, now: '2026-10-05T13:00:00.000Z' }));
  ok(readOut(root) === t1 && fs.statSync(path.join(root, 'data', 'news', 'headlines.json')).mtimeMs === mt, 'determinism: second run, no new items, later clock -> byte-identical, file untouched');
  feed.sky = rss([{ t: 'Sky news - D', p: rfc(-1 * H), s: 'D' }]);
  await NF.run(Object.assign({}, base, { root: root, fetchFn: fetchFeed, now: '2026-10-05T14:00:00.000Z' }));
  j = JSON.parse(readOut(root)); ok(j.generatedAt === '2026-10-05T14:00:00.000Z' && j.coins.sky.items.length === 1 && j.coins.monero.items.find(i => i.title === 'Newest item').firstSeenAt === NOW, 'new item changes content: generatedAt advances, earlier firstSeenAt kept');

  // ---- de-dup ----
  root = mkRoot(COINS.slice(0, 1));
  const dup = rss([{ t: 'Monero: Hits $500!! - X', p: rfc(-2 * H), s: 'X' }, { t: 'monero hits 500 - Y', p: rfc(-3 * H), s: 'Y' }, { t: 'Something else - Z', p: rfc(-4 * H), s: 'Z' }]);
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(dup) })); j = JSON.parse(readOut(root));
  ok(j.coins.monero.items.length === 2, 'de-dup: titles equal after lower-case + punctuation/whitespace collapse -> one item');
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(dup), now: '2026-10-05T12:30:00.000Z' }));
  ok(JSON.parse(readOut(root)).coins.monero.items.length === 2, 'de-dup: re-fetching the same items across runs adds nothing');
  const sameTitleOtherCoin = [{ cgId: 'a', symbol: 'a', name: 'A' }, { cgId: 'b', symbol: 'b', name: 'B' }];
  root = mkRoot(sameTitleOtherCoin); await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(rss([{ t: 'Shared headline - S', p: rfc(-H), s: 'S' }])) })); j = JSON.parse(readOut(root));
  ok(j.coins.a.items.length === 1 && j.coins.b.items.length === 1, 'de-dup is per coin (same title under two coins is kept for both)');

  // ---- 7-day prune, 15 cap ----
  root = mkRoot(COINS.slice(0, 1));
  const old = rss([{ t: 'Six days old - A', p: rfc(-6 * D), s: 'A' }, { t: 'Eight days old - B', p: rfc(-8 * D), s: 'B' }, { t: 'Fresh - C', p: rfc(-1 * H), s: 'C' }]);
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(old) })); j = JSON.parse(readOut(root));
  ok(j.coins.monero.items.map(i => i.title).join('|') === 'Fresh|Six days old', 'prune: items older than 7 days (by publishedAt) dropped on arrival');
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(rss([])), now: new Date(NOWMS + 2 * D).toISOString() })); j = JSON.parse(readOut(root));
  ok(j.coins.monero.items.map(i => i.title).join('|') === 'Fresh', 'prune: stored item ages out after 7 days (now + 2 d drops the 6-day-old one)');
  root = mkRoot(COINS.slice(0, 1)); const nodate = rss([{ t: 'Undated - A' }]);
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(nodate) }));
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(rss([])), now: new Date(NOWMS + 8 * D).toISOString() }));
  ok(JSON.parse(readOut(root)).coins.monero.items.length === 0, 'prune: item without publishedAt ages out by firstSeenAt');
  root = mkRoot(COINS.slice(0, 1)); const many = rss(Array.from({ length: 22 }, (_, i) => ({ t: 'Headline number ' + i + ' - S', p: rfc(-(i + 1) * H), s: 'S' })));
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(many) })); j = JSON.parse(readOut(root));
  ok(j.coins.monero.items.length === 15 && j.coins.monero.items[0].title === 'Headline number 0' && j.coins.monero.items[14].title === 'Headline number 14', 'cap: 15 per coin, newest first');

  // ---- failed coin keeps previous entries; retry ----
  root = mkRoot(COINS.slice(0, 2));
  await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(rss([{ t: 'Kept item - A', p: rfc(-H), s: 'A' }])) }));
  let calls = {};
  o = await NF.run(Object.assign({}, base, { root: root, now: '2026-10-05T13:00:00.000Z', fetchFn: async (u) => { const q = decodeURIComponent(u.split('q=')[1].split('&')[0]); calls[q] = (calls[q] || 0) + 1; if (/Monero/.test(q)) throw new Error('boom'); return resp(rss([{ t: 'Kept item - A', p: rfc(-H), s: 'A' }])); } }));
  j = JSON.parse(readOut(root));
  ok(j.coverage.ok === 1 && JSON.stringify(j.coverage.failed) === '["monero"]' && j.coins.monero.items.length === 1 && j.coins.monero.items[0].title === 'Kept item', 'failed coin: previous entries kept, listed in coverage.failed');
  ok(calls['"Monero" XMR crypto when:1d'] === 2, 'failed coin: exactly one retry (2 attempts)');
  let n = 0; root = mkRoot(COINS.slice(0, 1));
  o = await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => { n++; if (n === 1) return { ok: false, status: 503, text: async () => '' }; return resp(rss([{ t: 'After retry - A', p: rfc(-H), s: 'A' }])); } }));
  ok(n === 2 && o.coverage.ok === 1 && JSON.parse(readOut(root)).coins.monero.items.length === 1, 'retry: HTTP 503 then success -> coin ok');
  o = await NF.run(Object.assign({}, base, { root: mkRoot(COINS.slice(0, 1)), fetchFn: async () => resp('<html>consent page</html>') }));
  ok(o.coverage.failed.length === 1, 'non-RSS body counts as a failed coin (format change)');
  const t0 = Date.now(); o = await NF.run(Object.assign({}, base, { root: mkRoot(COINS.slice(0, 1)), timeoutMs: 40, fetchFn: (u, opt) => new Promise((res, rej) => { opt.signal.addEventListener('abort', () => rej(new Error('aborted'))); }) }));
  ok(o.coverage.failed.length === 1 && Date.now() - t0 < 3000, 'timeout: a hung request is aborted by the per-request timeout');

  // ---- exit-0 / safety ----
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'newsfetch-')); o = await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => { throw new Error('should not be called'); } }));
  ok(o.wrote === false && readOut(root) === null, 'missing latest-daily.json: nothing written, no throw');
  root = mkRoot(COINS.slice(0, 1), '{corrupt'); o = await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(rss([{ t: 'x - S', p: rfc(-H), s: 'S' }])) }));
  ok(JSON.parse(readOut(root)).coins.monero.items.length === 1, 'corrupt previous headlines.json: treated as absent');
  // size guard
  root = mkRoot(Array.from({ length: 40 }, (_, i) => ({ cgId: 'c' + i, symbol: 's' + i, name: 'C' + i })));
  const fat = rss(Array.from({ length: 15 }, (_, i) => ({ t: 'Long headline ' + 'x'.repeat(380) + ' ' + i + ' - S', p: rfc(-(i + 1) * H), s: 'S', l: 'https://news.google.com/rss/articles/' + 'L'.repeat(300) + i })));
  o = await NF.run(Object.assign({}, base, { root: root, fetchFn: async () => resp(fat) }));
  ok(o.bytes <= 300000 && o.cap < 15 && o.cap >= 3 && Buffer.byteLength(readOut(root)) <= 300000 && JSON.parse(readOut(root)).coins.c0.items.length === o.cap, 'size guard: output <= 300 KB by shrinking the per-coin cap uniformly (cap ' + o.cap + ', ' + o.bytes + ' bytes)');
  console.log('news-fetch-tests: ' + pass + '/' + total + ' passed'); process.exit(pass === total ? 0 : 1);
})().catch(e => { console.log('HARNESS ERROR', e.stack); process.exit(2); });
