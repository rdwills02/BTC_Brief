/* radar_tools/orders-core-exec-tests.js — LOCAL ONLY (never pushed). Protocol v1.4.3 Amendment §6 (t1–t20), §11 acceptance cases B1, B2, B3 and Astra's three 2026-10-02 fixtures.
 * Run: node orders-core-exec-tests.js [orders-core.js] [capture.js] [regression-runner.js]     -> "EXEC: n/m passed". Exit 1 on any failure.
 * Time model: REAL UTC timestamps (D = 2026-10-02 00:00Z, capture m issues m days later at 06:00:30 unless stated); 5-minute bars are keyed by their open time; nothing is keyed by a bar index.
 * Deterministic: no clock, no randomness, no network. Trades / OHLC / Ticker adapters run against recorded fixture responses through an injected fetch. */
'use strict';
var fs = require('fs'), path = require('path'), vm = require('vm');
var OC = require(path.resolve(process.argv[2] || './orders-core.js'));
var CAPFILE = path.resolve(process.argv[3] || './capture.js'), RRFILE = path.resolve(process.argv[4] || './regression-runner.js');
var DAY = 86400, D0 = Date.UTC(2026, 9, 2) / 1000, pass = 0, total = 0, SECT = 'exec';
function ok(c, name) { total++; if (c) pass++; else console.log('FAIL', SECT, name); }
function eq(a, b, name) { var A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, name + (A === B ? '' : '  got ' + A + ' want ' + B)); }
function iso(sec) { return new Date(sec * 1000).toISOString(); }
function dateOf(m) { return iso(D0 + m * DAY).slice(0, 10); }
function at(m, h, mi, s) { return D0 + m * DAY + h * 3600 + (mi || 0) * 60 + (s || 0); }
function hm(m, str) { var p = str.split(':'); return at(m, +p[0], +p[1], +(p[2] || 0)); }
function cap(m, h, mi, s) { var iss = at(m, h == null ? 6 : h, mi || 0, s == null ? 30 : s); return { captureId: 'c' + m, date: dateOf(m), inputCutoffSec: D0 + m * DAY, issueSec: iss, issueTimeUtc: iso(iss) }; }
var N0 = { id: 'N0', version: 'N0-v1' }, C1 = { id: 'C1', version: 'C1-test' };
function cand(o) {
  o = o || {}; var cg = o.cgId || 'X';
  return { episodeId: 'ep-' + cg, cgId: cg, pair: o.pair || (cg + 'USD'), screen: { pass: true }, price: o.price == null ? 100 : o.price, score: o.score == null ? 80 : o.score, venueEligible: true,
    meta: o.meta || { tick: 0.01, lot: 0.01, minOrder: 0.01 },
    entryEconomics: { entryZone: o.zone || [99, 101], stop: o.stop == null ? 90 : o.stop, target: o.target == null ? 120 : o.target, stopBasis: 'defended-low', targetSource: 'independent', netRR: 2.5 } };
}
function quote(ts, ask, extra) { return Object.assign({ tSubSec: ts, quoteObservedAtSec: ts - 1, ask: ask, bid: ask - 0.02, last: ask - 0.01 }, extra || {}); }
function prelude(book, c) { ['N0', 'C1'].forEach(function (p) { book = OC.valuation(book, p, c, {}); book = OC.suspend(book, p, c); }); return book; }
function issue(o) {   // capture 0 (or opts.cap): valuation + suspension, then N0 issuance of opts.cands with opts.quotes
  o = o || {}; var c = o.cap || cap(0), book = prelude(o.book || OC.newBook(), c);
  if (o.tweak) o.tweak(book);
  var r = OC.issueBatch(book, o.policy || N0, o.cands || [cand(o.cand)], c, { quotes: o.quotes, needs: o.needs, dailyProxy: o.proxy });
  return { book: r.book, r: r };
}
var lastNeeds = [];
function step(book, m, ev, c) {   // one canonical capture m >= 1: step 2 (adjudication), then 4 and 5 for both accounts
  c = c || cap(m); var needs = []; book = OC.adjudicateAll(book, c, ev || {}, { needs: needs });
  ['N0', 'C1'].forEach(function (p) { book = OC.valuation(book, p, c, ev || {}); book = OC.suspend(book, p, c); });
  lastNeeds = needs; return book;
}
function bar(t, o, h, l, c) { return { id: t, open: o, high: h, low: l, close: c }; }
function flat5(from, to, px, over) { var out = []; for (var t = Math.floor(from / 300) * 300; t < to; t += 300) { var x = over && over[t]; out.push(x ? bar(t, x[0], x[1], x[2], x[3]) : bar(t, px, px, px, px)); } return out; }
function day5(m, px, over, omit) { return flat5(D0 + m * DAY, D0 + (m + 1) * DAY, px, over).filter(function (b) { return !(omit && omit(b.id)); }); }
function dc(m, o, h, l, c) { return bar(D0 + m * DAY, o, h, l, c); }
function slice(from, to, complete, trades) { return { fromSec: from, toSec: to, complete: complete, trades: (trades || []).map(function (x, i) { return { t: x[0], p: x[1], n: i + 1 }; }) }; }
function flatDailies(upTo, px) { var out = []; for (var m = 1; m <= upTo; m++) out.push(dc(m, px, px + 1, px - 1, px)); return out; }
function ord(book, i) { return book.orders[i || 0]; }
function acct(book, p) { return book.accounts[p || 'N0']; }
var TSUB = at(0, 6, 0, 40), START = 1500000;

// ===================== t1–t3: submission-time evidence only =====================
(function () {
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book, o = ord(b0);
  ok(o.status === 'resting' && o.submittedAtSec === TSUB && o.quoteStatus === 'ok' && o.fill === null && o.L === 100 && o.S === 90 && o.T === 120, 't1 setup: ask 100.5 > L -> resting from t_sub');
  var over = {}; over[hm(0, '02:00')] = [100.2, 100.2, 99.5, 100.2];   // pre-submission touch of L (02:00), t_sub 06:00:40
  var b1 = step(b0, 1, { X: { bars5: day5(0, 101, over) } }); o = ord(b1);
  ok(o.status === 'resting' && !o.fill && o.eligibleDone === 1 && o.cursorSec === at(1, 0, 0), 't1 pre-submission low only (02:00 touch, t_sub 06:00:40) -> no fill; window 1 complete');
  ok(o.intraday.granularity === 300 && o.intraday.bars.length === (86400 - 21600) / 300 && o.intraday.bars[0].id === hm(0, '06:00') && !o.intraday.bars.some(function (x) { return x.id < hm(0, '06:00'); }), 't1 stored evidence = 216 bars from the straddling bar to 23:55; nothing before t_sub');
  eq(lastNeeds, [], 't3a straddling bar range clear of L -> resolved no-fill with no Trades request');
  // t2 post-submission 5-minute low at 08:00
  over = {}; over[hm(0, '08:00')] = [101, 101, 99.9, 100.5];
  b1 = step(b0, 1, { X: { bars5: day5(0, 101, over) } }); o = ord(b1);
  ok(o.fill && o.fill.price === 100 && o.fill.reason === 'limit' && o.fill.kind === 'maker' && o.fill.adverse === false && o.fill.tSec === hm(0, '08:00') && o.status === 'open', 't2 post-submission 5-min low at 08:00 -> fill at L, maker recorded');
  ok(o.fill.dayId === D0 && o.hDone === 1 && acct(b1).reservations.length === 0, 't2 fill day = D = holding day 1; reservation released');
  // t3b straddling bar touches L: Trades decide (first print at/below L - tick AFTER t_sub)
  over = {}; over[hm(0, '06:00')] = [100.5, 100.6, 99.95, 100.4];
  var trAfter = slice(hm(0, '06:00'), hm(0, '06:05'), true, [[hm(0, '06:00:05'), 99.9], [hm(0, '06:02:00'), 99.98], [hm(0, '06:03:00'), 100.3]]);
  b1 = step(b0, 1, { X: { bars5: day5(0, 101, over), trades: [trAfter] } }); o = ord(b1);
  ok(o.fill && o.fill.price === 100 && o.fill.kind === 'maker' && o.fill.tSec === hm(0, '06:02:00') && o.intraday.trades.length === 1 && o.intraday.trades[0].role === 'entry', 't3b Trades show a print <= L - tick after t_sub (06:02:00) -> fill at L; the pre-t_sub print (06:00:05) does not count');
  var trNone = slice(hm(0, '06:00'), hm(0, '06:05'), true, [[hm(0, '06:00:05'), 99.9], [hm(0, '06:02:00'), 100.2], [hm(0, '06:03:00'), 100.3]]);
  b1 = step(b0, 1, { X: { bars5: day5(0, 101, over), trades: [trNone] } }); o = ord(b1);
  ok(!o.fill && o.status === 'resting' && o.eligibleDone === 1, 't3b Trades show no print <= L - tick after t_sub (only a pre-submission print) -> no fill');
  b1 = step(b0, 1, { X: { bars5: day5(0, 101, over), trades: [slice(hm(0, '06:00'), hm(0, '06:05'), false, [])] } }); o = ord(b1);
  ok(o.status === 'pending-unresolved' && o.unresolved.reason === 'trades-unavailable' && o.eligibleDone === 0 && acct(b1).reservations.length === 1, 't3b Trades unavailable (incomplete slice) -> pending-unresolved, reservation held, window not advanced');
  b1 = step(b0, 1, { X: { bars5: day5(0, 101, over) } }); o = ord(b1);
  ok(o.status === 'pending-unresolved' && lastNeeds.some(function (n) { return n.kind === 'trades' && n.fromSec === TSUB && n.toSec === hm(0, '06:05') && n.cgId === 'X'; }), 't3b no Trades slice at all -> pending-unresolved and a Trades request {since = t_sub .. bar end} is emitted');
})();
// t3c: immediate ask fill at 05:54, S = 95, straddling bar low 94
(function () {
  var c = cap(0, 5, 53, 30), ts = at(0, 5, 54, 10), over = {}; over[hm(0, '05:50')] = [99.9, 100, 94, 99.8];
  var iss = issue({ cap: c, cand: { stop: 95 }, quotes: { XUSD: quote(ts, 99.8) } }), b0 = iss.book, o = ord(b0);
  ok(o.status === 'open' && o.fill.price === 99.8 && o.fill.reason === 'fill-crossing-ask' && o.S === 95 && o.fill.tSec === ts, 't3c immediate ask fill at 05:54:10, S = 95');
  var stopTr = slice(hm(0, '05:50'), hm(0, '05:55'), true, [[hm(0, '05:52:00'), 94], [hm(0, '05:54:30'), 94.5], [hm(0, '05:54:40'), 99.9]]);
  var b1 = step(b0, 1, { X: { bars5: day5(0, 99.9, over), trades: [stopTr] } }); o = ord(b1);
  ok(o.status === 'exited' && o.exit.reason === 'stop' && o.exit.price === 95 && o.exit.tSec === hm(0, '05:54:30') && o.exit.kind === 'taker', 't3c a print <= S after t_sub (05:54:30) -> stop at S');
  var preOnly = slice(hm(0, '05:50'), hm(0, '05:55'), true, [[hm(0, '05:52:00'), 94], [hm(0, '05:54:30'), 99.9]]);
  b1 = step(b0, 1, { X: { bars5: day5(0, 99.9, over), trades: [preOnly] } }); o = ord(b1);
  ok(o.status === 'open' && !o.exit && o.hDone === 1, 't3c the low print is BEFORE t_sub only -> no stop');
})();

// ===================== t4–t9: fill paths and the submission hour =====================
(function () {
  // t4: day-D open < L before submission is not an execution price (resting), and the submission-hour open is not a stop price after an ask fill
  var over = {}; over[hm(0, '00:00')] = [98, 101, 98, 101];
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book;
  var b1 = step(b0, 1, { X: { bars5: day5(0, 101, over), candles: [dc(0, 98, 101, 98, 101)] } });
  ok(!ord(b1).fill && ord(b1).status === 'resting', 't4 day-D open (98) < L before t_sub = 06:00:40 is NOT an execution price');
  over = {}; over[hm(0, '06:00')] = [89, 100.5, 89, 100];   // straddling bar opened at 89 <= S before submission
  b0 = issue({ quotes: { XUSD: quote(TSUB, 99.8) } }).book;
  var tr = slice(hm(0, '06:00'), hm(0, '06:05'), true, [[hm(0, '06:00:10'), 89], [hm(0, '06:01:00'), 99.9], [hm(0, '06:04:00'), 100]]);
  b1 = step(b0, 1, { X: { bars5: day5(0, 100, over), trades: [tr], candles: [dc(0, 85, 101, 84, 100)] } });
  ok(ord(b1).status === 'open' && !ord(b1).exit, 't4 after an ask fill the submission hour open (89 <= S) is never a stop price; post-t_sub prints are all above S');
})();
(function () {   // t5, t6, t6b, t7
  var o = ord(issue({ quotes: { XUSD: quote(TSUB, 100) } }).book);
  ok(o.status === 'open' && o.fill.price === 100 && o.fill.kind === 'taker' && o.fill.adverse === true && o.fill.reason === 'fill-crossing-ask' && o.fill.sizeProxy === 'top-of-book' && o.quoteStatus === 'ok', 't5 ask = L -> fill at ask, fill.kind taker / adverse recorded, size proxy labelled');
  o = ord(issue({ quotes: { XUSD: quote(TSUB, 100.5, { last: 99 }) } }).book);
  ok(o.status === 'resting' && !o.fill, 't6 last < L but ask > L -> resting (last is not an execution price)');
  var ts = at(0, 6, 1, 0);
  o = ord(issue({ quotes: { XUSD: { tSubSec: ts, missing: true } } }).book);
  ok(o.status === 'resting' && o.quoteStatus === 'quote-missing' && o.submittedAtSec === ts && !o.fill && o.quote === null, 't6b Ticker missing -> resting from the attempted-fetch time, quote-missing, no immediate fill');
  o = ord(issue({ quotes: { XUSD: quote(ts, 99, { quoteObservedAtSec: ts - 100 }) } }).book);
  ok(o.status === 'resting' && o.quoteStatus === 'quote-missing' && !o.fill, 't6b stale quote (observed 100 s before submission) cannot create a fill');
  var needs = [], i = issue({ needs: needs }); o = ord(i.book);
  ok(o.status === 'resting' && o.quoteStatus === 'quote-missing' && o.submittedAtSec === cap(0).issueSec && needs.length === 1 && needs[0].kind === 'ticker' && needs[0].pair === 'XUSD', 't6b no snapshot supplied -> a Ticker request for the pair is emitted; the order rests from t_dec (never midnight)');
  var iss = issue({ cand: {}, quotes: { XUSD: quote(TSUB, 89) } }); o = ord(iss.book);
  ok(o.status === 'rejected-invalid-at-submission' && acct(iss.book).reservations.length === 0 && iss.book.attempts.length === 1 && iss.book.attempts[0].outcome === 'rejected-invalid-at-submission' && OC.exposureCoins(iss.book).length === 0,
    't7 ask <= S -> rejected-invalid-at-submission, attempt consumed, reservation released, no slot held');
  ok(o.events.filter(function (e) { return e.type === 'reservation-released'; }).length === 1, 't7 reservation released exactly once');
})();
(function () {   // t8, t9
  var ts = TSUB, over = {};
  over[hm(0, '02:00')] = [100, 100, 85, 100];              // pre-submission low far below S
  over[hm(0, '06:00')] = [99.9, 99.95, 89, 99.9];          // straddling bar: range touches S (the 89 print was pre-submission)
  var b0 = issue({ quotes: { XUSD: quote(ts, 99.8) } }).book;
  var tr = slice(hm(0, '06:00'), hm(0, '06:05'), true, [[hm(0, '06:00:02'), 89.5], [hm(0, '06:00:50'), 99.9], [hm(0, '06:02:00'), 100]]);
  var b1 = step(b0, 1, { X: { bars5: day5(0, 100, over), trades: [tr] } }); var o = ord(b1);
  ok(o.status === 'open' && !o.exit && !o.intraday.bars.some(function (x) { return x.id < hm(0, '06:00'); }), 't8 pre-submission lows (02:00 bar, 06:00:02 print) after a t_sub fill -> no stop');
  over = {}; over[hm(0, '10:00')] = [100, 100.5, 89.9, 100];
  b1 = step(b0, 1, { X: { bars5: day5(0, 100, over), trades: [slice(hm(0, '06:00'), hm(0, '06:05'), true, [])] } }); o = ord(b1);
  ok(o.status === 'exited' && o.exit.reason === 'stop' && o.exit.price === 90 && o.exit.tSec === hm(0, '10:00') && o.exit.kind === 'taker' && o.exit.adverse === false, 't9 post-submission 5-min low <= S after the fill -> stop at S');
})();
(function () {   // t10: window 2 (D+1 daily bar) open below L fills at that open
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book;
  var b1 = step(b0, 1, { X: { bars5: day5(0, 101) } });
  var b2 = step(b1, 2, { X: { bars5: day5(0, 101), candles: [dc(1, 98.5, 101, 98, 100)] } }), o = ord(b2);
  ok(o.status === 'open' && o.fill.price === 98.5 && o.fill.reason === 'fill-gap-open' && o.fill.kind === 'taker' && o.fill.adverse === true && o.fill.dayId === D0 + DAY && o.fill.tSec === D0 + DAY, 't10 D+1 open (98.5) < L -> fill at the open, taker adverse, window 2');
  var b2b = step(b1, 2, { X: { bars5: day5(0, 101), candles: [dc(1, 101, 102, 99.9, 100)] } });
  ok(ord(b2b).fill && ord(b2b).fill.reason === 'limit' && ord(b2b).fill.price === 100 && ord(b2b).fill.kind === 'maker', 't10 D+1 open >= L with low <= L - tick -> limit fill at L (maker)');
  var b3 = step(step(b1, 2, { X: { bars5: day5(0, 101), candles: [dc(1, 101, 102, 100.5, 100.6)] } }), 3, { X: { candles: [dc(1, 101, 102, 100.5, 100.6), dc(2, 97, 101, 96, 100)] } });
  ok(ord(b3).fill && ord(b3).fill.price === 97 && ord(b3).fill.reason === 'fill-gap-open', 't10 window 3 (D+2) open below L also fills at the open (no window-index guard, no crossing rejection)');
})();

// ===================== t11: unresolved intervals =====================
(function () {
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book;
  var b1 = step(b0, 1, { X: { candles: [dc(0, 101, 102, 100.5, 101)] } }), o = ord(b1);
  ok(o.status === 'pending-unresolved' && o.unresolved.reason === 'bars5-missing' && o.unresolved.fromSec === TSUB && acct(b1).reservations.length === 1 && OC.exposureCoins(b1).length === 1 && o.eligibleDone === 0, 't11 intraday missing at D+1 -> pending-unresolved, reservation and slot held');
  ok(lastNeeds.some(function (n) { return n.kind === 'bars5' && n.cgId === 'X' && n.fromSec === TSUB; }), 't11 the missing intraday interval is requested');
  var over = {}; over[hm(0, '08:00')] = [101, 101, 99.9, 100.5];
  var b2 = step(b1, 2, { X: { bars5: day5(0, 101, over) } }); o = ord(b2);
  ok(o.status === 'open' && o.fill.price === 100 && o.fill.tSec === hm(0, '08:00') && !o.unresolved && acct(b2).reservations.length === 0, 't11 the evidence arrives at D+2 -> adjudicated: fill at L (08:00), unresolved cleared');
  // interior gap 12:00–12:55
  var gap = function (t) { return t >= hm(0, '12:00') && t < hm(0, '13:00'); };
  b1 = step(b0, 1, { X: { bars5: day5(0, 101, null, gap), candles: [dc(0, 101, 102, 100.5, 101)] } }); o = ord(b1);
  ok(o.status === 'pending-unresolved' && o.unresolved.fromSec === hm(0, '12:00') && o.unresolved.toSec === at(1, 0, 0) && o.cursorSec === hm(0, '12:00') && o.eligibleDone === 0, 't11 interior gap -> THAT interval is unresolved; cursor stops at the gap start (06:00:40..12:00 resolved no-fill)');
  b2 = step(b1, 2, { X: { bars5: day5(0, 101, null, gap), candles: [dc(0, 101, 102, 100.5, 101), dc(1, 98, 101, 97, 100)] } }); o = ord(b2);
  ok(o.status === 'pending-unresolved' && !o.fill && o.eligibleDone === 0, 't11 the D+1 daily bar (open 98 < L) is NOT adjudicated ahead of the unresolved interval');
  var b3 = step(b2, 3, { X: { bars5: day5(0, 101), candles: [dc(0, 101, 102, 100.5, 101), dc(1, 98, 101, 97, 100)] } }); o = ord(b3);
  ok(o.status === 'open' && o.fill.price === 98 && o.fill.reason === 'fill-gap-open' && o.fill.tSec === D0 + DAY, 't11 gap filled later -> windows resume in order: window 1 no-fill, window 2 fills at the D+1 open');
  // never arrives
  var bn = b0; for (var m = 1; m <= 5; m++) bn = step(bn, m, { X: { candles: flatDailies(m - 1, 101) } }); o = ord(bn);
  ok(o.status === 'pending-unresolved' && acct(bn).reservations.length === 1 && o.eligibleDone === 0 && !o.fill, 't11 intraday never arrives: after D+2 (and beyond) the order is still non-terminal, window not advanced, reservation held, closed to new fills');
  var un = OC.unresolvedOf(bn, 'N0', { deadlineSec: at(5, 0, 0) }), u = un[0];
  ok(un.length === 1 && u.cls.row === 2 && u.S1.kind === 'filled-stopped' && u.S1.tsSec >= o.submittedAtSec && u.S1.tsSec === at(1, 0, 0) && u.S2.kind === 'expired' && u.S2.tsSec === at(5, 0, 0), 't11 never arrives -> missing-outcome scenario mapping (unknown entry), S1 timestamp >= t_sub');
})();
// ===================== t12, t13: cancel-pending and expiry =====================
function drawdown(book, p, frac) {   // force HWM so that the account sits at drawdown `frac` (before any charge)
  var a = acct(book, p), E = a.lastValuation.E; a.hwm = Math.ceil(E / (1 - frac)); a.lastValuation.HWM = a.hwm;
}
(function () {
  // t12: suspension at capture 1 while window 1 (start t_sub) is unadjudicated -> cancel-pending; remaining windows counted from window START
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book;
  var c1 = cap(1); var b1 = OC.adjudicateAll(b0, c1, { X: { candles: [] } }, { needs: [] });
  b1 = OC.valuation(b1, 'N0', c1, {}); acct(b1).lastValuation.E = Math.floor(acct(b1).lastValuation.HWM * 0.8);
  b1 = OC.suspend(b1, 'N0', c1); var o = ord(b1);
  ok(o.status === 'cancel-pending' && o.cancelCutoffSec === at(1, 0, 0), 't12 window 1 starts at t_sub (< cutoff D+1 00:00) and is unadjudicated -> cancel-pending with the cutoff recorded');
  eq(OC.obligations(b1).map(function (x) { return x.remainingBars; }), [1], 't12 obligations: windows opening before the cutoff = 1 (window 1 at t_sub; D+1 starts AT the cutoff and is excluded)');
  var over = {}; over[hm(0, '08:00')] = [101, 101, 99.9, 100.5];
  var b2 = step(b1, 2, { X: { bars5: day5(0, 101, over) } }); o = ord(b2);
  ok(o.status === 'open' && o.fill.tSec === hm(0, '08:00'), 't12 the cancel-pending order still fills inside window 1 (it opened before the cutoff)');
  b2 = step(b1, 2, { X: { bars5: day5(0, 101) } }); o = ord(b2);
  ok(o.status === 'cancelled-suspension' && acct(b2).reservations.length === 0, 't12 window 1 unfilled -> cancelled-suspension once the cutoff is reached; reservation released');
})();
(function () {
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book, b = b0;
  var cs = [dc(0, 101, 102, 100.5, 101)];
  b = step(b, 1, { X: { bars5: day5(0, 101), candles: cs.slice() } });
  cs.push(dc(1, 101, 102, 100.5, 101)); b = step(b, 2, { X: { bars5: day5(0, 101), candles: cs.slice() } });
  ok(ord(b).status === 'resting' && ord(b).eligibleDone === 2, 't13 after windows D and D+1: still resting');
  cs.push(dc(2, 101, 102, 100.5, 101)); b = step(b, 3, { X: { bars5: day5(0, 101), candles: cs.slice() } }); var o = ord(b);
  ok(o.status === 'expired' && o.expiryAtSec === at(3, 0, 0) && acct(b).reservations.length === 0 && o.events.some(function (e) { return e.type === 'status' && e.to === 'expired' && e.captureId === 'c3'; }), 't13 expiry at the end of D+2 (mid-day submission): expired; expiry time recorded apart from the adjudicating capture');
  cs.push(dc(3, 80, 101, 79, 100)); var b4 = step(b, 4, { X: { bars5: day5(0, 101), candles: cs.slice() } });
  ok(ord(b4).status === 'expired' && !ord(b4).fill && acct(b4).cash === acct(b).cash, 't13 a D+3 price (open 80 < L) creates nothing');
})();
// ===================== t14, t15, t16 =====================
(function () {
  var q = { XUSD: quote(TSUB, 99.8) }, a1 = issue({ quotes: q }).book, a2 = issue({ quotes: q }).book;
  eq(a1, a2, 't14 capture D re-run from the same prior state is deterministic (identical book)');
  var c = cap(0), r2 = OC.issueBatch(a1, N0, [cand()], c, { quotes: q });
  ok(r2.book.orders.length === 1 && r2.book.attempts.length === 1 && acct(r2.book).cash === acct(a1).cash && r2.results.length === 0, 't14 issuance re-applied to the result: no second order, no second fill (attempt keyed on policy + episode)');
  var o = ord(a1), n = o.fill.notionalCents;
  ok(acct(a1).cash === START - n - o.fill.feeCents - o.fill.frictionCents && o.events.filter(function (e) { return e.type === 'reservation-released'; }).length === 1 && o.events.filter(function (e) { return e.type === 'filled'; }).length === 1, 't14 one fill, one charge, one reservation release');
  var b1 = step(a1, 1, { X: { bars5: day5(0, 100) } }), b1b = step(b1, 1, { X: { bars5: day5(0, 100) } });
  eq(b1b, b1, 't14 adjudicating the same capture twice is a no-op (event-sourced)');
  // t15 same-capture series row reconciles
  var row = acct(a1).series[acct(a1).series.length - 1];
  ok(row.captureId === 'c0' && row.cash === acct(a1).cash && row.marked === n && row.E === row.cash + row.marked && row.reserved === 0 && acct(a1).series.length === 1 && row.E === START - o.fill.feeCents - o.fill.frictionCents, 't15 series row re-written after the fill: cash, marked (at the fill price), E reconcile; one row for the capture');
  var again = OC.valuation(a1, 'N0', c, {}); eq(acct(again).series, acct(a1).series, 't15 a further valuation of the same capture reproduces the row (no second mark)');
  ok(acct(a1).lastValuation.E === row.E && acct(a1).hwm === START, 't15 lastValuation / HWM consistent with the row');
  // t16 B, Q, S, T unchanged by any fill path
  var paths = [99.8, 100.5, 89].map(function (ask) { return ord(issue({ quotes: { XUSD: quote(TSUB, ask) } }).book); });
  ok(paths.every(function (x) { return x.Bcents === paths[0].Bcents && x.Q === paths[0].Q && x.S === 90 && x.T === 120 && x.L === 100; }) && paths[0].Bcents === 22500 && paths[0].Q > 0 && paths[0].qty === paths[0].Q / 100,
    't16 B, Q, S, T, L identical across the ask-fill / resting / rejected paths (frozen before the snapshot)');
  ok(paths[0].status === 'open' && paths[1].status === 'resting' && paths[2].status === 'rejected-invalid-at-submission', 't16 the three paths differ only in status');
})();
// ===================== t18: in-sequence suspension =====================
function threeCands() { return [cand({ cgId: 'A', score: 90 }), cand({ cgId: 'B', score: 80 }), cand({ cgId: 'C', score: 70 })]; }
(function () {
  var q = { AUSD: quote(TSUB, 100.5), BUSD: quote(at(0, 6, 2, 0), 99.8), CUSD: quote(at(0, 6, 3, 0), 100.5) };
  var i = issue({ cands: threeCands(), quotes: q, tweak: function (b) { drawdown(b, 'N0', 0.1495); } }), b = i.book, a = acct(b);
  var A = b.orders.filter(function (x) { return x.cgId === 'A'; })[0], B = b.orders.filter(function (x) { return x.cgId === 'B'; })[0];
  ok(B.status === 'open' && B.fill.reason === 'fill-crossing-ask', 't18 B fills at the ask');
  ok(a.suspended === true && a.suspensionCutoffSec === at(0, 6, 2, 0) && a.suspendedAt === dateOf(0), 't18 the immediate fill\'s charges cross the 15% drawdown threshold -> suspension fires in-sequence, cutoff = t_sub of that fill (06:02:00), not midnight');
  ok(i.book.orders.length === 2 && i.book.attempts.length === 2 && !i.book.attempts.some(function (x) { return x.cgId === 'C'; }) && i.r.blockedReason === 'suspended-mid-capture', 't18 the later same-capture candidate C is not issued (no order, no attempt)');
  ok(A.status === 'cancel-pending' && A.cancelCutoffSec === at(0, 6, 2, 0), 't18 the earlier resting order A (opened 06:00:40 < cutoff) becomes cancel-pending with that cutoff');
  var row = a.series[a.series.length - 1]; ok(row.suspended === true && row.blockedReason === 'suspended-mid-capture', 't18 the capture\'s series row carries the suspension');
  ok(a.suspensionCutoffSec > A.submittedAtSec, 't18 a cutoff before the order existed would be invalid; here cutoff > t_sub of A');
})();
// ===================== t19: factual vs scenario charge parity =====================
(function () {
  function runPath(kind) {
    var b, steps;
    if (kind === 'fill-crossing-ask') {
      b = issue({ quotes: { XUSD: quote(TSUB, 99.8) } }).book; var over = {}; over[hm(0, '10:00')] = [100, 120.5, 100, 120];
      b = step(b, 1, { X: { bars5: day5(0, 100, over), trades: [slice(hm(0, '06:00'), hm(0, '06:05'), true, [])], candles: [] } });
    } else if (kind === 'limit') {
      b = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book; var o2 = {}; o2[hm(0, '08:00')] = [101, 101, 99.9, 100.5]; o2[hm(0, '12:00')] = [101, 121, 101, 120];
      b = step(b, 1, { X: { bars5: day5(0, 101, o2), candles: [] } });
    } else {
      b = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book;
      b = step(b, 1, { X: { bars5: day5(0, 101), candles: [] } });
      b = step(b, 2, { X: { bars5: day5(0, 101), candles: [dc(1, 98.5, 101, 98, 100)] } });
      b = step(b, 3, { X: { bars5: day5(0, 101), candles: [dc(1, 98.5, 101, 98, 100), dc(2, 100, 121, 99, 120)] } });
    }
    return b;
  }
  ['fill-crossing-ask', 'fill-gap-open', 'limit'].forEach(function (reason) {
    var b = runPath(reason), o = ord(b), sc = OC.buildScenarios(b, { deadlineSec: at(9, 0, 0) }), t = sc.paths.S2.N0.trades[0], t1 = sc.paths.S1.N0.trades[0];
    ok(o.status === 'exited' && o.fill.reason === reason && o.exit.reason === 'target', 't19 ' + reason + ': factual fill then target exit');
    ok(t && t.kind === 'factual' && t.pnlCents === o.exit.pnlCents && t1.pnlCents === o.exit.pnlCents, 't19 ' + reason + ': scenario entry charges (read from fill.kind / fill.adverse) reproduce the factual P&L to the cent');
    var adv = sc.paths.S2adv.N0.trades[0], f = o.fill, e = o.exit, fch = OC.sideCharges(f.notionalCents, 'taker', true, 'allAdverse'), xch = OC.sideCharges(e.notionalCents, 'taker', true, 'allAdverse');
    ok(adv.pnlCents === e.notionalCents - xch.feeCents - xch.frictionCents - (f.notionalCents + fch.feeCents + fch.frictionCents), 't19 ' + reason + ': all-adverse cost mode charges both sides at taker + adverse');
  });
  var ob = ord(runPath('limit')); ok(ob.fill.kind === 'maker' && ob.fill.adverse === false && ord(runPath('fill-gap-open')).fill.kind === 'taker' && ord(runPath('fill-crossing-ask')).fill.adverse === true, 't19 kind / adverse recorded per reason');
})();
// ===================== t20: boundary traverse =====================
(function () {
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 100.5) } }).book, over = {}; over[hm(0, '09:05')] = [101, 101, 99.9, 100.5];
  var daily = [], b = b0, snaps = {};
  for (var m = 1; m <= 21; m++) {
    if (m >= 2) daily.push(dc(m - 1, 100.5, 101, 100, 100.5));
    b = step(b, m, { X: { bars5: day5(0, 101, over), candles: daily.slice() } });
    if (m === 1 || m === 2 || m === 5 || m === 10) snaps[m] = { hDone: ord(b).hDone, nb: ord(b).bars.length };
  }
  var o = ord(b), ids = o.intraday.bars.map(function (x) { return x.id; });
  ok(o.fill.tSec === hm(0, '09:05') && o.fill.barId === hm(0, '09:05') && o.fill.dayId === D0 && o.fill.reason === 'limit', 't20 5-minute fill at 09:05 on D');
  ok(ids[0] === hm(0, '06:00') && ids.length === 216 && ids.every(function (x, i) { return i === 0 || x - ids[i - 1] === 300; }) && ids[ids.length - 1] === at(0, 23, 55) && ids.indexOf(hm(0, '09:05')) === 37, 't20 5-minute bars 06:00 (straddling) .. 23:55 each processed once, in order, no gap (216 bars; entry bars before 09:05, fill bar, then exit bars)');
  eq(snaps[1], { hDone: 1, nb: 0 }, 't20 after the first midnight crossing: holding-day counter = 1 (fill day), no daily bar consumed');
  eq(snaps[2], { hDone: 2, nb: 1 }, 't20 D+1 daily bar = holding day 2'); eq(snaps[5], { hDone: 5, nb: 4 }, 't20 holding day 5 = daily bar D+4');
  var dbs = o.bars.map(function (x) { return x.id; }), want = []; for (var k = 1; k <= 19; k++) want.push(D0 + k * DAY);
  eq(dbs, want, 't20 daily bars D+1..D+19 each processed exactly once, in order');
  ok(o.exit && o.exit.reason === 'horizon' && o.exit.barId === D0 + 9 * DAY && o.status === 'exited', 't20 primary horizon exit at the holding-day-10 close = bar D+9 (unchanged endpoint)');
  ok(o.sens.exit && o.sens.exit.reason === 'horizon' && o.sens.exit.barId === D0 + 19 * DAY && o.hDone === 20, 't20 20-bar horizon endpoint = the D+19 close; counter 20');
  var b2 = step(b, 21, { X: { bars5: day5(0, 101, over), candles: daily.slice() } }); eq(b2, b, 't20 re-running a capture after the horizon changes nothing');
})();
// ===================== B1: known fill + unresolved exit interval =====================
(function () {
  var b0 = issue({ quotes: { XUSD: quote(TSUB, 99.8) } }).book, over = {}; over[hm(0, '06:00')] = [99.9, 100, 89, 99.9];
  var b1 = step(b0, 1, { X: { bars5: day5(0, 100, over), trades: [slice(hm(0, '06:00'), hm(0, '06:05'), false, [])] } }), o = ord(b1), a = acct(b1), f = o.fill;
  ok(o.status === 'open' && o.unresolved && o.unresolved.phase === 'exit' && o.unresolved.reason === 'trades-unavailable' && o.hDone === 0, 'B1 immediate ask fill + unavailable stop-relevant interval -> open position with an unresolved-EXIT cursor');
  ok(a.reservations.length === 0 && a.cash === START - f.notionalCents - f.feeCents - f.frictionCents && OC.exposureCoins(b1).length === 1 && o.events.filter(function (e) { return e.type === 'filled'; }).length === 1, 'B1 ordinary open exposure, ONE entry charge, no pending-entry reservation restored');
  var un = OC.unresolvedOf(b1, 'N0', { deadlineSec: at(3, 0, 0) });
  ok(un.length === 1 && un[0].cls.row === 3 && un[0].cls.kind === 'open-exit-unresolved' && un[0].S1.kind === 'exit-at-zero' && un[0].S2.kind === 'exit-at-last-usable-close' && un[0].S2.tsSec >= o.fill.tSec && un[0].S1.tsSec >= o.fill.tSec, 'B1 classification: unresolved EXIT (open-position branch); both scenario timestamps >= the fill');
  var sc = OC.buildScenarios(b1, { deadlineSec: at(3, 0, 0) });
  ['S1', 'S2', 'S1adv', 'S2adv'].forEach(function (S) { var p = sc.paths[S].N0; ok(p.trades.length === 1 && p.trades[0].filled === true && p.inadmissible.length === 0 && !p.resolutions.some(function (r) { return r.kind === 'filled-stopped' || r.kind === 'expired' || r.kind === 'skipped-missing-input'; }), 'B1 scenario ' + S + ': no purchase imputed, no unfilled-expiry reclassification; the open position is exited'); });
})();
// ===================== B2: timestamp clipping at a cancellation cutoff =====================
(function () {
  function setup() {   // A rests from 05:00:10; B fills at 06:02:00 and suspends in-sequence -> A is cancel-pending with cutoff 06:02:00
    var q = { AUSD: quote(at(0, 5, 0, 10), 100.5), BUSD: quote(at(0, 6, 2, 0), 99.8) };
    return issue({ cap: cap(0, 5, 0, 5), cands: [cand({ cgId: 'A', score: 90 }), cand({ cgId: 'B', score: 80 })], quotes: q, tweak: function (b) { drawdown(b, 'N0', 0.1495); } }).book;
  }
  var b0 = setup(), A = b0.orders.filter(function (x) { return x.cgId === 'A'; })[0];
  ok(A.status === 'cancel-pending' && A.cancelCutoffSec === at(0, 6, 2, 0) && acct(b0).suspended, 'B2 setup: A resting since 05:00:10, cancelled at 06:02:00');
  function evid(trades) { var over = {}; over[hm(0, '06:00')] = [100.5, 100.6, 99.9, 100.4]; return { A: { bars5: day5(0, 101, over), trades: trades }, B: { bars5: day5(0, 100) } }; }
  var late = slice(hm(0, '06:00'), hm(0, '06:05'), true, [[hm(0, '06:01:00') + 59, 100.2], [hm(0, '06:04:00'), 99.9]]);
  var b1 = step(b0, 1, evid([late])), a = b1.orders.filter(function (x) { return x.cgId === 'A'; })[0];
  ok(a.status === 'cancelled-suspension' && !a.fill && acct(b1).reservations.every(function (r) { return r.orderId !== a.id; }), 'B2 cancelled 06:02, limit first reached 06:04 -> NO fill (the daily/bar range would have said yes)');
  var early = slice(hm(0, '06:00'), hm(0, '06:05'), true, [[hm(0, '06:01:00'), 99.9], [hm(0, '06:04:00'), 99.9]]);
  b1 = step(b0, 1, evid([early])); a = b1.orders.filter(function (x) { return x.cgId === 'A'; })[0];
  ok(a.status === 'open' && a.fill.price === 100 && a.fill.tSec === hm(0, '06:01:00') && a.fill.kind === 'maker', 'B2 limit reached 06:01 (before the cancel) -> the pre-cutoff fill stands');
  ok(a.hDone === 1 && a.cursorSec === at(1, 0, 0) && a.intraday.bars[a.intraday.bars.length - 1].id === at(0, 23, 55), 'B2 a pre-cutoff fill continues into exit processing beyond the cutoff (rest of day D processed)');
  var bad = slice(hm(0, '06:00'), hm(0, '06:05'), false, []);
  b1 = step(b0, 1, evid([bad])); a = b1.orders.filter(function (x) { return x.cgId === 'A'; })[0];
  ok(a.status === 'cancel-pending' && a.unresolved && a.unresolved.phase === 'entry' && a.unresolved.reason === 'trades-unavailable' && acct(b1).reservations.some(function (r) { return r.orderId === a.id; }), 'B2 ordering unavailable -> unresolved (cancel-pending, reservation held)');
})();
// ===================== proxy mode and structural checks =====================
(function () {
  var b0 = issue({ proxy: true, quotes: { XUSD: quote(TSUB, 99) } }).book, o = ord(b0);
  ok(o.status === 'resting' && o.proxy === 'daily-no-intraday' && o.w0 === 1 && o.cursorSec === at(1, 0, 0) && o.expiryAtSec === at(4, 0, 0), 'proxy: no ask fill and no intraday window; windows D+1..D+3');
  var b2 = step(step(b0, 1, { X: { candles: [dc(0, 101, 102, 100.5, 101)] } }), 2, { X: { candles: [dc(0, 101, 102, 100.5, 101), dc(1, 98, 101, 97, 100)] } });
  ok(ord(b2).fill && ord(b2).fill.price === 98 && ord(b2).fill.reason === 'fill-gap-open' && ord(b2).fill.dayId === D0 + DAY, 'proxy: D+1 open < L fills at the open (no rejected-crossing, no rejected-gap)');
  var src = fs.readFileSync(path.resolve(process.argv[2] || './orders-core.js'), 'utf8'), blk = src.slice(src.indexOf('var PENDING'), src.indexOf('function num('));
  ok(!/rejected-crossing|rejected-gap|skipped-missing-input|issued/.test(blk) && typeof OC.activateAll === 'undefined' && typeof OC.activateOrder === 'undefined', 'retired: no rejected-crossing / rejected-gap / skipped-missing-input / issued in TERMINAL / TRANSITIONS; activateAll / activateOrder removed');
  var threw = false; try { OC.adjudicateAll({ schemaVersion: 1, orders: [], attempts: [], accounts: {} }, cap(1), {}); } catch (e) { threw = /schemaVersion/.test(e.message); }
  ok(threw && OC.ORDERS_SCHEMA_VERSION === 2 && OC.newBook().schemaVersion === 2, 'schema: ORDERS_SCHEMA_VERSION 2; a v1.4.2 (schema 1) book is refused, never migrated');
})();

// ===================== Astra's three 2026-10-02 orders (real timestamps): fill at the D+1 open =====================
(function () {
  var F = [
    { cg: 'morpho', pair: 'MORPHOUSD', L: 2.58227, S: 2.37002, T: 3.00596, meta: { tick: 1e-05, lot: 9.999999999999999e-06, minOrder: 2 }, open: 2.5715, bar: [2.5715, 2.79961, 2.54569, 2.7557] },
    { cg: 'binancecoin', pair: 'BNBUSD', L: 776.39, S: 731.93, T: 847.04, meta: { tick: 0.01, lot: 9.999999999999999e-06, minOrder: 0.007 }, open: 768.21, bar: [768.21, 792.25, 764.72, 787.2] },
    { cg: 'ethereum', pair: 'ETHUSD', L: 2694.52, S: 2590.92, T: 2896.22, meta: { tick: 0.01, lot: 1e-08, minOrder: 0.001 }, open: 2668.1, bar: [2668.1, 2689.77, 2665.01, 2687.02] }
  ];
  var issueSec = Date.UTC(2026, 9, 2, 5, 54, 57) / 1000, c0 = { captureId: '20261002T055457807Z-6b1ea8', date: '2026-10-02', inputCutoffSec: 1790899200, issueSec: issueSec, issueTimeUtc: '2026-10-02T05:54:57.807Z' };
  ok(c0.inputCutoffSec === D0, 'fixtures: D = 2026-10-02 00:00Z');
  F.forEach(function (f) {
    var q = {}; q[f.pair] = quote(issueSec + 20, f.L * 1.01);   // ask above L: resting
    var iss = issue({ cap: c0, cands: [cand({ cgId: f.cg, pair: f.pair, price: f.L, zone: [f.L, f.L], stop: f.S, target: f.T, meta: f.meta })], quotes: q }), o = iss.book.orders[0];
    ok(o.L === f.L && o.S === f.S && o.T === f.T && o.status === 'resting', 'fixture ' + f.cg + ': levels L ' + f.L + ' / S ' + f.S + ' reproduced; resting');
    var ev = {}; ev[f.cg] = { bars5: day5(0, f.L * 1.02) };
    var c1 = { captureId: '20261003T053229653Z-ec7ea9', date: '2026-10-03', inputCutoffSec: D0 + DAY, issueSec: Date.UTC(2026, 9, 3, 5, 32, 29) / 1000, issueTimeUtc: '2026-10-03T05:32:29.653Z' };
    var b = OC.adjudicateAll(iss.book, c1, ev, { needs: [] }); ['N0', 'C1'].forEach(function (p) { b = OC.valuation(b, p, c1, ev); b = OC.suspend(b, p, c1); });
    var c2 = { captureId: '20261004T060838469Z-1d41e2', date: '2026-10-04', inputCutoffSec: D0 + 2 * DAY, issueSec: Date.UTC(2026, 9, 4, 6, 8, 38) / 1000, issueTimeUtc: '2026-10-04T06:08:38.469Z' };
    ev[f.cg].candles = [bar(D0 + DAY, f.bar[0], f.bar[1], f.bar[2], f.bar[3])];
    b = OC.adjudicateAll(b, c2, ev, { needs: [] }); var fo = b.orders[0];
    ok(fo.status === 'open' && fo.fill.price === f.open && fo.fill.reason === 'fill-gap-open' && fo.fill.kind === 'taker' && fo.fill.adverse === true && fo.fill.dayId === D0 + DAY, 'fixture ' + f.cg + ': D+1 open ' + f.open + ' < L ' + f.L + ' -> fill at the open under window 2 (was rejected-crossing under v1.4.2)');
  });
})();

// ===================== t17: regression-runner feasibility funnel (declared daily proxy) =====================
(function () {
  var src = fs.readFileSync(RRFILE, 'utf8'), a = src.indexOf('// ---- FEASIBILITY BEGIN'), e = src.indexOf('// ---- FEASIBILITY END'), blk = src.slice(a, e);
  ok(a > 0 && e > a && !/rejectedCrossing|rejectedGap|skippedMissingInput|rejected-crossing|rejected-gap/.test(blk), 't17 funnel: no rejectedCrossing / rejectedGap / skippedMissingInput branch or counter');
  ok(/feasibility-proxy: daily-no-intraday/.test(blk), 't17 funnel carries the label feasibility-proxy: daily-no-intraday');
  var RR; try { RR = require(RRFILE); } catch (err) { RR = null; }
  ok(!!RR && typeof RR.step14FeasibilityFunnel === 'function', 't17 runner module loads and exports step14FeasibilityFunnel');
  if (RR && RR.step14FeasibilityFunnel) {
    var days = [{ eligible: 1, candidates: [{ cgId: 'c', episodeId: 'e1', score: 1, L: 100, S: 90, T: 120 }] }, { eligible: 0, candidates: [] }, { eligible: 0, candidates: [] }, { eligible: 0, candidates: [] }, { eligible: 0, candidates: [] }];
    var series = { c: { 0: { open: 99, high: 99, low: 70, close: 80 }, 1: { open: 98, high: 101, low: 97, close: 100 }, 2: { open: 100, high: 101, low: 99, close: 100 }, 3: { open: 100, high: 101, low: 99, close: 100 }, 4: { open: 100, high: 101, low: 99, close: 100 } } };
    var r = RR.step14FeasibilityFunnel(days, series, {});
    ok(r.proxy === 'feasibility-proxy: daily-no-intraday' && r.funnel.filled === 1 && r.funnel.resting === 1 && r.fillDays[0] === 1 && !('rejectedGap' in r.funnel) && !('rejectedCrossing' in r.funnel), 't17 D close below S no longer rejects; D+1 open (98) < L fills at the open on bar D+1 (fill day D+1)');
    series.c[1] = { open: 105, high: 106, low: 104, close: 105 }; series.c[2] = { open: 99, high: 105, low: 98, close: 100 };
    r = RR.step14FeasibilityFunnel(days, series, {});
    ok(r.funnel.filled === 1 && r.fillDays[0] === 2, 't17 an open below L on bar D+2 also fills (no window-index guard)');
  }
})();
// ===================== adapters (recorded fixture responses, injected fetch) + protocolVersion (acceptance G) =====================
if (process.env.SKIP_ADAPTERS) { console.log(SECT + ' (core only): ' + pass + '/' + total + ' passed'); process.exit(pass === total ? 0 : 1); }
(function () {
  var SRC = fs.readFileSync(CAPFILE, 'utf8');
  function extract(header) {
    var i = SRC.indexOf(header); if (i < 0) throw new Error('not found in capture.js: ' + header);
    if (/^(var|const) /.test(header)) return SRC.slice(i, SRC.indexOf('\n', i) + 1);
    var j = SRC.indexOf('{', SRC.indexOf(')', i)), d = 0, k = j;
    for (; k < SRC.length; k++) {
      var ch = SRC[k], nx = SRC[k + 1];
      if (ch === '/' && nx === '/') { k = SRC.indexOf('\n', k); continue; }
      if (ch === '"' || ch === "'") { var q = ch; k++; while (SRC[k] !== q) { if (SRC[k] === '\\') k++; k++; } continue; }
      if (ch === '`') { k++; while (SRC[k] !== '`') { if (SRC[k] === '\\') k++; k++; } continue; }
      if (ch === '/' && /[=(,:]\s*$/.test(SRC.slice(Math.max(0, k - 3), k))) { k++; while (SRC[k] !== '/') { if (SRC[k] === '\\') k++; k++; } continue; }
      if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) break; }
    }
    return SRC.slice(i, k + 1);
  }
  var names = ['var FWD_KNOWN_GATE_IDS', 'var FWD_ACCEPTED_PROTOCOLS', 'var FWD_TRADES_PAGE', 'var FWD_TRADES_MAX_PAGES', 'var FWD_BAR5', 'function fwdParseTicker(', 'function fwdParseOhlc5(', 'function fwdParseTrades(', 'async function fwdFetchBars5(', 'async function fwdFetchTradesSlice(', 'async function fwdFetchQuotes(', 'function fwdProtocolErrors(', 'function fwdConfigErrors('];
  var code = names.map(extract).join('\n');
  var ctx = { Math: Math, JSON: JSON, Number: Number, String: String, Array: Array, Object: Object, BigInt: BigInt, isFinite: isFinite, parseInt: parseInt, Promise: Promise, Error: Error };
  vm.createContext(ctx); vm.runInContext(code + '\nthis.api = { fwdParseTicker, fwdParseOhlc5, fwdParseTrades, fwdFetchBars5, fwdFetchTradesSlice, fwdFetchQuotes, fwdProtocolErrors, fwdConfigErrors, FWD_ACCEPTED_PROTOCOLS };', ctx);
  var api = ctx.api;
  // ---- G: protocolVersion strict equality list ----
  eq(api.fwdProtocolErrors({ protocolVersion: 'forward-experiment-v1.4.3' }), [], 'G forward-experiment-v1.4.3 accepted');
  ok(api.fwdProtocolErrors({ protocolVersion: 'forward-experiment-v1.4.2' }).length === 1, 'G forward-experiment-v1.4.2 rejected');
  ok(api.fwdProtocolErrors({ protocolVersion: 'something-else' }).length === 1 && api.fwdProtocolErrors({ protocolVersion: 'forward-experiment-v1.4.3-x' }).length === 1 && api.fwdProtocolErrors({ protocolVersion: 'forward-experiment-v1.4' }).length === 1, 'G an unknown string and prefix / suffix variants are rejected (strict equality, not prefix)');
  ok(api.fwdConfigErrors({ OC: OC }, { protocolVersion: 'forward-experiment-v1.4.2', challenger: null }).length >= 1 && api.fwdConfigErrors({ OC: OC }, { protocolVersion: 'forward-experiment-v1.4.3', challenger: null }).length === 0, 'G the startup configuration check carries the protocolVersion error (a rejected version makes every capture an extra capture)');
  // ---- Ticker ----
  var ap = { XBTUSD: { key: 'XXBTZUSD' }, ETHUSD: { key: 'XETHZUSD' } };
  var tk = api.fwdParseTicker({ error: [], result: { XXBTZUSD: { a: ['100.5', '1', '1.000'], b: ['100.4', '1', '1.000'], c: ['100.45', '0.5'] }, XETHZUSD: { a: ['0', '1', '1'], b: ['1', '1', '1'], c: ['2', '1'] } } }, ap);
  eq(tk, { XBTUSD: { last: 100.45, ask: 100.5, bid: 100.4 }, ETHUSD: { last: 2, ask: null, bid: 1 } }, 'Ticker parse -> {last, ask, bid}; a non-positive ask is null (the entry is kept on a valid last, as before)');
  (async function () {
    var clock = (function () { var t = [Date.UTC(2026, 9, 2, 6, 0, 10, 250), Date.UTC(2026, 9, 2, 6, 0, 10, 900)]; return function () { return t.shift(); }; })();
    var qs = await api.fwdFetchQuotes(async function () { return { error: [], result: { XXBTZUSD: { a: ['100.5', '1', '1'], b: ['100.4', '1', '1'], c: ['100.45', '1'] } } }; }, ['XBTUSD', 'ETHUSD'], ap, clock);
    eq(qs.XBTUSD, { tSubSec: Math.ceil(Date.UTC(2026, 9, 2, 6, 0, 10, 900) / 1000), quoteObservedAtSec: Math.floor(Date.UTC(2026, 9, 2, 6, 0, 10, 250) / 1000), ask: 100.5, bid: 100.4, last: 100.45 }, 'Ticker snapshot: t_sub = response time rounded UP, quote observed = request time rounded down');
    ok(qs.ETHUSD && qs.ETHUSD.missing === true && typeof qs.ETHUSD.tSubSec === 'number', 'Ticker: a pair absent from the response is recorded as missing with the attempted-fetch time');
    var qf = await api.fwdFetchQuotes(async function () { throw new Error('network'); }, ['XBTUSD'], ap, function () { return Date.UTC(2026, 9, 2, 6, 0, 10, 0); });
    ok(qf.XBTUSD.missing === true && /network/.test(qf.XBTUSD.error), 'Ticker: a failed fetch -> missing');
    // ---- OHLC interval=5 ----
    var ohlc = { error: [], result: { XXBTZUSD: [[300, '10', '12', '9', '11', '10.5', '5', 3], [600, '11', '13', '10', '12', '11', '5', 4], [900, '12', '12', '12', '12', '12', '0', 0]], last: 600 } };
    var pr = api.fwdParseOhlc5(ohlc);
    eq(pr.bars, [{ id: 300, open: 10, high: 12, low: 9, close: 11 }, { id: 600, open: 11, high: 13, low: 10, close: 12 }, { id: 900, open: 12, high: 12, low: 12, close: 12 }], 'OHLC5 parse: ascending bars keyed by open time');
    ok(!api.fwdParseOhlc5({ error: ['EGeneral:Invalid'], result: {} }).ok && !api.fwdParseOhlc5({ error: [], result: { X: [[300, 'a', 'b', 'c', 'd']] } }).ok && !api.fwdParseOhlc5({ error: [], result: { X: [[301, '1', '2', '0.5', '1']] } }).ok, 'OHLC5 parse: error / non-numeric / off-grid bars -> not ok');
    var seen = []; var fb = await api.fwdFetchBars5(async function (u) { seen.push(u); return ohlc; }, 'XBTUSD', 1790000000);
    ok(fb.ok && fb.bars.length === 3 && /OHLC\?pair=XBTUSD&interval=5&since=1790000000$/.test(seen[0]), 'OHLC5 fetch: pair, interval=5, since passed through');
    ok(!(await api.fwdFetchBars5(async function () { throw new Error('boom'); }, 'XBTUSD', 1)).ok, 'OHLC5 fetch failure -> not ok');
    // ---- Trades (B3) ----
    function page(rows, last) { return { error: [], result: { XXBTZUSD: rows.map(function (r) { return [String(r[1]), '1.0', r[0], 'b', 'l', '', r[2]]; }), last: last } }; }
    var T0s = hm(0, '06:00:40'), TE = hm(0, '06:05'), ns = function (sec) { return String(BigInt(Math.round(sec * 1000)) * 1000000n); };
    var p1 = page([[T0s + 1.5, 100.5, 11], [T0s + 20.25, 100.6, 12], [T0s + 40.5, 100.4, 13]], ns(T0s + 40.5));   // page 1: no touch (L - tick = 99.99), full page (pageSize 3)
    var p2 = page([[T0s + 100.1, 100.3, 14], [T0s + 150.75, 99.9, 15], [TE + 2, 100, 16]], ns(TE + 2));            // page 2: a touch inside the interval, then a print past the end
    var urls = [], f2 = async function (u) { urls.push(u); return urls.length === 1 ? p1 : p2; };
    var sl = await api.fwdFetchTradesSlice(f2, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(sl.complete === true && sl.fromSec === T0s && sl.toSec === TE && sl.trades.length >= 5 && urls.length === 2 && urls[1].slice(-p1.result.last.length) === p1.result.last && /since=/.test(urls[1]) && /since=\d+$/.test(urls[0]), 'B3 two pages: continuation value preserved verbatim; coverage reaches the interval end (a print past the end); slice complete');
    var tsOf = sl.trades.map(function (x) { return x.t; }); ok(tsOf.every(function (t, i) { return i === 0 || t >= tsOf[i - 1]; }) && tsOf[0] >= T0s, 'B3 trades ordered by (time, id); nothing before the submission instant is kept');
    var ex = { 0: [{ id: T0s, open: 100.5, high: 100.6, low: 99.9, close: 100.4 }] };
    var ev = {}; ev.X = { bars5: day5(0, 101, (function () { var o = {}; o[hm(0, '06:00')] = [100.5, 100.6, 99.9, 100.4]; return o; })()), trades: [sl] };
    var b0 = issue({ quotes: { XUSD: quote(T0s, 100.5) } }).book, b1 = step(b0, 1, ev), o = ord(b1);
    ok(o.fill && o.fill.price === 100 && o.fill.tSec === T0s + 150.75, 'B3 page 1 no touch, page 2 a touch inside the interval -> the engine finds the event and fills at L');
    var urls2 = [], f3 = async function (u) { urls2.push(u); if (urls2.length === 1) return p1; throw new Error('HTTP 502'); };
    var sf = await api.fwdFetchTradesSlice(f3, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(sf.complete === false && /page-2|page 2|HTTP 502/.test(sf.reason), 'B3 page 2 unavailable -> incomplete slice');
    ev.X.trades = [sf]; b1 = step(b0, 1, ev); o = ord(b1);
    ok(o.status === 'pending-unresolved' && o.unresolved.reason === 'trades-unavailable' && !o.fill, 'B3 page 2 unavailable -> the interval is UNRESOLVED (never the most recent page, never an assumed no-event)');
    var p2err = { error: ['EService:Unavailable'], result: {} };
    var s3 = await api.fwdFetchTradesSlice(async function (u) { return u.slice(-p1.result.last.length) === p1.result.last ? p2err : p1; }, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(s3.complete === false, 'B3 an API error on page 2 -> incomplete');
    var stall = await api.fwdFetchTradesSlice(async function () { return p1; }, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(stall.complete === false && /stall|duplicate|continuation/.test(stall.reason), 'B3 a continuation value that does not advance -> incomplete (no infinite loop)');
    var tn = 0; var trunc = await api.fwdFetchTradesSlice(async function (u) { var n = tn++; return page([[T0s + 1 + n, 100.5, 100 + n * 3], [T0s + 1.1 + n, 100.5, 101 + n * 3], [T0s + 1.2 + n, 100.5, 102 + n * 3]], ns(T0s + 1.2 + n)); }, 'XBTUSD', T0s, TE, { pageSize: 3, maxPages: 4, nowSec: TE + 3600 });
    ok(trunc.complete === false && /truncat/.test(trunc.reason), 'B3 page budget exhausted before coverage reaches the interval end -> incomplete (truncation)');
    var quiet = await api.fwdFetchTradesSlice(async function () { return page([[T0s + 5, 100.5, 21], [T0s + 60, 100.6, 22]], ns(T0s + 60)); }, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(quiet.complete === true && quiet.trades.length === 2, 'B3 a short last page with now >= interval end covers the interval: complete, no event');
    var early = await api.fwdFetchTradesSlice(async function () { return page([[T0s + 5, 100.5, 21]], ns(T0s + 5)); }, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: T0s + 60 });
    ok(early.complete === false, 'B3 a short last page while the interval end is still in the future -> incomplete');
    var gapIds = await api.fwdFetchTradesSlice(async function () { return page([[T0s + 5, 100.5, 21], [T0s + 6, 100.5, 25]], ns(T0s + 6)); }, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(gapIds.complete === false && /id-gap/.test(gapIds.reason), 'B3 a gap in the venue trade ids -> incomplete');
    var outr = await api.fwdFetchTradesSlice(async function () { return page([[T0s - 500, 100.5, 21], [T0s + 6, 100.5, 22]], ns(T0s + 6)); }, 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(outr.complete === false && /out-of-range/.test(outr.reason), 'B3 a first page that starts before the requested instant (not the requested range) -> incomplete');
    var dup = await api.fwdFetchTradesSlice((function () { var n = 0; return async function () { n++; return n === 1 ? page([[T0s + 1, 100.5, 31], [T0s + 2, 100.5, 32], [T0s + 3, 100.5, 33]], ns(T0s + 3)) : page([[T0s + 3, 100.5, 33], [T0s + 4, 100.5, 34]], ns(T0s + 4)); }; })(), 'XBTUSD', T0s, TE, { pageSize: 3, nowSec: TE + 3600 });
    ok(dup.complete === true && dup.trades.length === 4 && dup.trades.every(function (x, i, a) { return i === 0 || x.n > a[i - 1].n; }), 'B3 an overlapping boundary record (id 33 on both pages) is de-duplicated deterministically');
    console.log(SECT + ': ' + pass + '/' + total + ' passed');
    process.exit(pass === total ? 0 : 1);
  })().catch(function (e) { console.log('ADAPTER TEST ERROR', e && e.stack || e); process.exit(1); });
})();
