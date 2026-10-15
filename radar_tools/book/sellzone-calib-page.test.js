#!/usr/bin/env node
/* item 52p: headless test of sellzone-calib.html with every network call stubbed (the two REAL 2026-10-14 14:00 batches in fixtures/ serve as depth).
   Run: NODE_PATH=<dir with playwright> CHROMIUM=<path> node sellzone-calib-page.test.js
   Cross-hour fixture at page level: the selected record was received 14:01 UTC, the cutoff is 15:03 UTC -> the baseline window, candle request, cache key, example metadata and replay all use H = 14:00. */
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { chromium } = require('playwright');
const HERE = __dirname, FX = path.join(HERE, 'fixtures'), HOUR = 3600000;
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL: ' + m); } };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-10-14T15:10:00.000Z'), H14 = Date.parse('2026-10-14T14:00:00.000Z');
const RESEARCH = JSON.stringify({ captureTime: '2026-10-14T00:52:00.000Z', captureId: 'test', coins: [{ symbol: 'eth', cgId: 'ethereum', volume24h: 20000000000, research: { entryEconomics: { entryLow: 2440, entryHigh: 2460, target: 2560, targetSource: 'independent' } } }] });
function krakenRows(since) { const rows = []; for (let t = H14 - 170 * HOUR; t <= H14 + 2 * HOUR; t += HOUR) if (t / 1000 >= since) rows.push([t / 1000, '2400', '2410', '2390', '2400', '2400', '10', 5]); return rows; }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined }), ctx = await browser.newContext(), page = await ctx.newPage(), reqs = [], errs = [];
  page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 160)); });
  await page.addInitScript(n => { const R = Date.now; Date.now = () => n; }, NOW);
  await page.route('**/*', r => {
    const u = new URL(r.request().url()), p = u.pathname, q = u.search; reqs.push(u.host + p + q);
    const j = (o, s) => r.fulfill({ status: s || 200, contentType: 'application/json', body: typeof o === 'string' ? o : JSON.stringify(o) });
    if (u.host === 'localhost:8123') {
      if (p === '/page.html') return r.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(HERE, 'sellzone-calib.html')) });
      if (/^\/(book-core|book-codec|sellzone-core)\.js$/.test(p)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(HERE, p.slice(1))) });
      if (p === '/repo/book/grids.json') return j({ updatedAt: '2026-10-14T14:05:00Z', grids: { 'kraken|ETH/USD': { version: 2 } } });
      if (p === '/repo/book/cadence.json') return j({ version: 'test', updatedAt: '2026-10-14T00:00:00Z', table: [{ venue: 'kraken', pair: 'ETH/USD', tier: 'test', cadenceMs: 900000, fromMs: 0, toMs: null }] });
      if (p === '/repo/book/kraken/2026-10-14/1400.json.gz') return r.fulfill({ status: 200, contentType: 'application/gzip', body: fs.readFileSync(path.join(FX, 'v2-kraken-2026-10-14T1400.json.gz')) });
      if (p === '/daily.json') return j(RESEARCH);
      return r.fulfill({ status: 404, body: 'nf' });
    }
    if (u.host === 'api.kraken.com' && p === '/0/public/AssetPairs') return j({ error: [], result: { XETHZUSD: { wsname: 'ETH/USD', altname: 'ETHUSD' } } });
    if (u.host === 'api.kraken.com' && p === '/0/public/OHLC') return j({ error: [], result: { XETHZUSD: krakenRows(+u.searchParams.get('since')), last: 1 } });
    if (u.host === 'api.coingecko.com') return j([{ id: 'ethereum', total_volume: 25000000000, last_updated: '2026-10-14T15:08:00.000Z' }]);
    return r.fulfill({ status: 404, body: 'nf' });
  });
  await page.goto('http://localhost:8123/page.html'); await page.waitForFunction(() => window.__calib && document.getElementById('load'));
  await page.fill('#repo', 'http://localhost:8123/repo/'); await page.fill('#daily', 'http://localhost:8123/daily.json');
  await page.click('#load'); await page.waitForSelector('#pairs input'); await page.check('#pairs input[value="kraken|ETH/USD"]');
  await page.fill('#cutoffs', '2026-10-14T15:03:00Z'); await page.click('#run'); await page.waitForFunction(() => /done in|ERROR/.test(document.getElementById('log').textContent), null, { timeout: 60000 });
  const log = await page.evaluate(() => document.getElementById('log').textContent); ok(/done in/.test(log), 'run completes | ' + log.slice(-300));
  const b = await page.evaluate(() => { const x = window.__bundle, e = x.examples[0]; return { H: e.H, cutoffH: e.cutoffH, baselineH: e.baselineH, cutoff: e.cutoff, recv: e.record && e.record.recv, bwin: e.baseline && e.baseline.window, bstatus: e.baseline && e.baseline.status, valid: e.baseline && e.baseline.validHours, hourly: e.baseline && e.baseline.hourly.length, vc: e.venueContext && { lstatus: e.venueContext.local.status, lh: e.venueContext.local.hours.length, ps: e.venueContext.pairShare24h, cmp: e.venueContext.comparability, g: e.venueContext.globalInput && { coin: e.venueContext.globalInput.coinId, v: e.venueContext.globalInput.value, ref: e.venueContext.globalInput.rawRef } }, zshare: e.results && Object.values(e.results)[0].zones.map(z => z.zoneShareGlobal24h && z.zoneShareGlobal24h.status), files: x.files.map(f => f.name), mods: Object.keys(window.__mods).map(n => [n, window.__mods[n].sha256]), mf: JSON.parse(x.files.filter(f => f.name === 'manifest.json')[0].text), summary: x.files.filter(f => f.name === 'summary.md')[0].text }; });
  ok(b.recv && b.recv.startsWith('2026-10-14T14:01'), 'the selected record was received 14:01 | ' + b.recv);
  ok(b.H === '2026-10-14T14:00:00.000Z' && b.baselineH === b.H && b.cutoffH === '2026-10-14T15:00:00.000Z', 'B1: example H / baselineH = the record\'s hour (14:00), cutoffH = 15:00 | ' + JSON.stringify([b.H, b.baselineH, b.cutoffH]));
  ok(b.bwin && b.bwin.end === '2026-10-14T14:00:00.000Z' && b.bwin.start === new Date(H14 - 168 * HOUR).toISOString() && b.bstatus === 'complete' && b.valid === 168 && b.hourly === 168, 'B1: baseline window ends at 14:00 (not 15:00), 168 valid hours, derived hourly series retained | ' + JSON.stringify(b.bwin));
  const ohlc = reqs.filter(r => /api\.kraken\.com\/0\/public\/OHLC/.test(r)); ok(ohlc.length === 1 && ohlc[0].endsWith('since=' + (H14 / 1000 - 168 * 3600 - 1)), 'B1: the candle request starts at the record window (H = 14:00), one request | ' + JSON.stringify(ohlc));
  ok(b.files.some(f => /^candles\/kraken-ETH_USD-20261014T140000Z\.json$/.test(f)) && !b.files.some(f => /T150000Z/.test(f)), 'B1: candle file keyed by the record hour');
  ok(b.vc && b.vc.lstatus === 'complete' && b.vc.lh === 24 && b.vc.ps.status === 'ok' && b.vc.cmp.status === 'ok' && b.vc.g && b.vc.g.coin === 'ethereum' && b.vc.g.v === 25000000000, 'venue context: local 24 h complete, live global snapshot used, ratio available | ' + JSON.stringify(b.vc));
  ok(Math.abs(b.vc.ps.value - (24 * 24000) / 25000000000) < 1e-12, 'pairShare24h = 24 h quote turnover / reported global volume | ' + b.vc.ps.value);
  ok(Array.isArray(b.zshare) && b.zshare.every(s => s === 'ok' || s === 'unavailable'), 'each zone carries zoneShareGlobal24h');
  ok(['modules/book-core.js', 'modules/book-codec.js', 'modules/sellzone-core.js', 'inputs/cadence.json', 'inputs/research-latest-daily.json', 'batches/book_kraken_2026-10-14_1400.json.gz'].every(n => b.files.includes(n)) && b.files.some(f => /^global\/ethereum-/.test(f)), 'evidence retained: module bytes, cadence, research file, selected compressed batch, raw global response | ' + b.files.join(','));
  ok(b.mods.every(([n, h]) => h === sha(fs.readFileSync(path.join(HERE, n))) && b.mf.moduleSha256[n] === h), 'manifest module hashes = hashes of the executed bytes (computed before execution)');
  ok(/current hypothetical geometry on historical books/.test(b.summary), 'summary labels the E/T application'); ok(/## Venue context/.test(b.summary), 'summary has the venue-context section');
  const bad = await page.evaluate(() => window.__verify()); ok(Array.isArray(bad) && bad.length === 0, 'verify: hashes match and every example recomputes identically | ' + JSON.stringify(bad)); 
  ok(errs.length === 0, 'no console errors | ' + JSON.stringify(errs));
  console.log('sellzone-calib page: ' + pass + ' passed, ' + fail + ' failed'); await browser.close(); process.exitCode = fail ? 1 : 0;
})();
