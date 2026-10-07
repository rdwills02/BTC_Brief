/* orders-core.js — Forward Experiment Protocol v1.2 §4–§6 (orders, execution, accounts, scenarios). Pure: no fs, no Date, no globals, no I/O.
 * setups-core.js (the B0 ledger) is untouched; B0 stays a continuity reference. Detection logic is untouched: S and T are taken exactly as logged
 * (Protocol §4.1: the ATR-capped stop may sit above the defended low; an independent resistance line is the target without a nearer-swing-high check).
 *
 * BOOK = { schemaVersion, orders[], attempts[], accounts: { N0: acct, C1: acct } }. All functions take a book and return a NEW book (deep clone).
 * Protocol v1.4.3 (Amendment: ordinary limits, immediate submission, timestamp-valid evidence). Pipeline, called by capture.js per canonical capture, in this order:
 *   2 adjudicateAll(book, capture, barsByCoin, opts)  [step 3 (activation) is RETIRED: an order is submitted at issuance]
 *   4 valuation(book, policyId, capture, barsByCoin)  5 suspend(book, policyId, capture)
 *   7 issueBatch(book, policy, candidates, capture, cfg)   cfg.quotes = { [pair]: submission-time Ticker snapshot }, cfg.needs = [] collects missing evidence
 * barsByCoin = { [cgId]: { candles: [{id,open,high,low,close}], bars5: [{id,open,high,low,close}], trades: [{fromSec,toSec,complete,trades:[{t,p,n}]}] } } — daily candles USABLE at the capture's
 * issueTimeUtc (id = open time, unix s); bars5 = Kraken 5-minute bars (id = open time); trades = timestamped Trades slices whose coverage is declared by fromSec/toSec/complete.
 * capture = { captureId, date, inputCutoffSec, issueTimeUtc, issueSec }. All USD amounts are integer cents; prices are real numbers on the tick grid.
 * Order state is event-sourced: order.events is append-only, keyed (type|barId|k); re-applying an event is a no-op.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.OrdersCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var ORDERS_SCHEMA_VERSION = 2, DAY = 86400, BAR5 = 300;
  // Constants (Protocol §0, §4, §5). Basis points are integers so every charge is computed exactly.
  var CFG = {
    START_CASH: 1500000,          // $15,000 (§5.2)
    BUDGET_BP: 150,               // 1R budget B = 1.5% of E_issue (§0), in basis points of 10,000
    RISK_LIMIT_BP: 450,           // admitted risk <= 3 x 1.5% x E_issue (§5.4)
    SLOTS: 3, EXPIRY_BARS: 3, HORIZON_BAR: 10, RETAIN_BARS: 20,
    DD_SUSPEND_NUM: 15, DD_SUSPEND_DEN: 100,   // drawdown >= 15% inclusive (§5.5)
    STALE_PERSISTENT_AT: 4,       // 4th consecutive capture without a usable mark (§0)
    MAKER_BP: 30, TAKER_BP: 60, FRICTION_BASE_BP: 10, FRICTION_ADVERSE_BP: 25,
    FEE_RESERVE_BP: 120,          // feeReserve = 2 x 0.60% x (E_issue/3)
    QUOTE_MAX_AGE_SEC: 30,        // v1.4.3: a Ticker snapshot whose request-to-response latency exceeds this is stale (treated as missing)
    TRADES_STORE_MAX: 400         // trades kept per stored slice on the order
  };
  // v1.4.3: `issued` (holding state), `skipped-missing-input`, `rejected-gap`, `rejected-crossing` are retired. An order is created `resting` at its submission instant; `expired` is reached only from
  // `resting` (an unresolved interval keeps the order `pending-unresolved`: expiry closes the window to NEW fills, it never erases unknown execution).
  var PENDING = { resting: 1, 'pending-unresolved': 1, 'cancel-pending': 1 };
  var TERMINAL = { 'rejected-invalid-at-submission': 1, expired: 1, 'cancelled-suspension': 1, exited: 1 };
  var TRANSITIONS = {
    resting: { 'rejected-invalid-at-submission': 1, 'pending-unresolved': 1, expired: 1, open: 1, 'cancelled-suspension': 1, 'cancel-pending': 1 },
    'pending-unresolved': { resting: 1, open: 1, 'cancel-pending': 1 },
    'cancel-pending': { 'cancelled-suspension': 1, open: 1 },
    open: { exited: 1 }
  };

  // ---------- money and price helpers ----------
  function num(v) { return typeof v === 'number' && isFinite(v); }
  var curStep = null;   // pipeline step tag for events written by the current call (used by the scenario replay)
  var inPlace = false;   // test-only switch (property tests): skip the defensive deep clone of the book; default is pure
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function cloneBook(b) { return inPlace ? b : clone(b); }
  function cents(dollars) { var r = Math.round(dollars * 100 * 1e6) / 1e6; return Math.floor(r + 0.5); }          // half-up, floating noise removed
  function bpOf(nCents, bp) { return Math.floor((2 * nCents * bp + 10000) / 20000); }                            // half-up on integers
  function clean(x) { return Math.round(x * 1e10) / 1e10; }
  function floorTo(x, t) { var r = x / t, k = Math.round(r); if (Math.abs(r - k) > 1e-9 * Math.max(1, Math.abs(r))) k = Math.floor(r); return clean(k * t); }
  function ceilTo(x, t) { var r = x / t, k = Math.round(r); if (Math.abs(r - k) > 1e-9 * Math.max(1, Math.abs(r))) k = Math.ceil(r); return clean(k * t); }
  function notional(qLots, lotsInv, price) { return cents(qLots * price / lotsInv); }
  function chargeBps(kind, adverse, mode) { if (mode === 'allAdverse') return { fee: CFG.TAKER_BP, fr: CFG.FRICTION_ADVERSE_BP }; return { fee: kind === 'maker' ? CFG.MAKER_BP : CFG.TAKER_BP, fr: adverse ? CFG.FRICTION_ADVERSE_BP : CFG.FRICTION_BASE_BP }; }
  // Executed side: fee and friction are separate fields, each on the executed notional (§0).
  function sideCharges(nCents, kind, adverse, mode) { var b = chargeBps(kind, adverse, mode); return { feeCents: bpOf(nCents, b.fee), frictionCents: bpOf(nCents, b.fr) }; }

  // ---------- book / account / order ----------
  function newAccount(id, cash) { return { policyId: id, startCash: cash, cash: cash, reservations: [], series: [], hwm: null, suspended: false, suspendedAt: null, suspensionCutoffSec: null, riskLimitExceeded: false, lastValuation: null }; }
  function newBook(opts) { var c = (opts && opts.startCash) || CFG.START_CASH; return { schemaVersion: ORDERS_SCHEMA_VERSION, orders: [], attempts: [], seq: 0, accounts: { N0: newAccount('N0', c), C1: newAccount('C1', c) } }; }

  // Item 40 (shadow study): a separate book whose accounts are the listed shadow policy ids (e.g. CTRL, NZ); never merged into a production book.
  function newShadowBook(ids, startCash) { var c = startCash || 1500000, acc = {}; (ids || []).forEach(function (id) { acc[id] = newAccount(id, c); }); return { schemaVersion: ORDERS_SCHEMA_VERSION, orders: [], attempts: [], seq: 0, accounts: acc }; }

  function indexBars(barsByCoin) {
    var out = {};
    Object.keys(barsByCoin || {}).forEach(function (cg) { var m = {}; ((barsByCoin[cg] && barsByCoin[cg].candles) || []).forEach(function (c) { m[c.id] = c; }); out[cg] = m; });
    return out;
  }

  function addEv(o, capture, type, extra) {
    extra = extra || {};
    var key = type + '|' + (extra.barId != null ? extra.barId : '') + '|' + (extra.k || '');
    for (var i = 0; i < o.events.length; i++) if (o.events[i].key === key) return false;   // event-sourced: re-applying is a no-op
    var ev = { key: key, type: type, captureId: capture ? capture.captureId : null, date: capture ? capture.date : null, step: extra.step || curStep };
    Object.keys(extra).forEach(function (k) { if (k !== 'k') ev[k] = extra[k]; });
    o.events.push(ev); return true;
  }
  function setStatus(o, next) {
    if (o.status === next) return;
    if (TERMINAL[o.status] || !(TRANSITIONS[o.status] && TRANSITIONS[o.status][next])) throw new Error('illegal order transition ' + o.status + ' -> ' + next + ' (' + o.id + ')');
    o.status = next;
  }
  function releaseReservation(book, o, capture, why) {   // once per order: the reservation record exists or it does not
    var a = book.accounts[o.policyId];
    for (var i = 0; i < a.reservations.length; i++) if (a.reservations[i].orderId === o.id) { a.reservations.splice(i, 1); addEv(o, capture, 'reservation-released', { why: why }); return true; }
    return false;
  }
  function terminate(book, o, capture, status, why, step) { setStatus(o, status); releaseReservation(book, o, capture, why || status); addEv(o, capture, 'status', { to: status, step: step || null, k: status }); }
  function reservedSum(a) { var s = 0; a.reservations.forEach(function (r) { s += r.cents; }); return s; }
  function ordersOf(book, pid) { return book.orders.filter(function (o) { return o.policyId === pid; }); }
  function isPending(o) { return !!PENDING[o.status]; }
  function isOpen(o) { return o.status === 'open'; }

  // ---------- exits (§4.4, §4.5) ----------
  // Returns null or { reason, price, kind: 'maker'|'taker', adverse }.
  function exitRules(bar, o, isHorizonBar) {
    var S = o.S, T = o.T, tk = o.tick, up = clean(T + tk);
    if (bar.open <= S) return { reason: 'gap-stop', price: bar.open, kind: 'taker', adverse: true };
    if (bar.open >= up) return { reason: 'gap-target', price: bar.open, kind: 'maker', adverse: false };
    if (bar.low <= S && bar.high >= up) return { reason: 'conflict-stop', price: S, kind: 'taker', adverse: true };
    if (bar.low <= S) return { reason: 'stop', price: S, kind: 'taker', adverse: false };
    if (bar.high >= up) return { reason: 'target', price: T, kind: 'maker', adverse: false };
    if (isHorizonBar) return { reason: 'horizon', price: bar.close, kind: 'taker', adverse: false };
    return null;
  }
  function exitRecord(o, r, bar, capture, mode) {
    var n = notional(o.Q, o.lotsInv, r.price), ch = sideCharges(n, r.kind, r.adverse, mode);
    var entry = o.fill, pnl = n - ch.feeCents - ch.frictionCents - (entry.notionalCents + entry.feeCents + entry.frictionCents);
    return { reason: r.reason, price: r.price, barId: bar.id, tSec: r.tSec != null ? r.tSec : bar.id, kind: r.kind, adverse: r.adverse, notionalCents: n, feeCents: ch.feeCents, frictionCents: ch.frictionCents,
      pnlCents: pnl, budgetR: o.Bcents ? pnl / o.Bcents : null, plannedRiskR: pnl / plannedRiskCents(o), captureId: capture.captureId, date: capture.date };
  }
  function plannedRiskCents(o) { return notional(o.Q, o.lotsInv, o.L - o.S) || 1; }

  // ---------- v1.4.3 evidence model (Amendment §1, §3, §11) ----------
  // Windows of an order (entry): w = 0 is [submittedAtSec, end of D) resolved from 5-minute bars (range rule on the straddling bar, Trades when the range touches a barrier);
  // w = 1, 2 are the daily bars D+1, D+2. EXPIRY_BARS windows in all. In the declared daily proxy (replay / calibration only) window 0 does not exist and the windows are D+1..D+3 (w0 = 1).
  // The intraday cursor (o.cursorSec, seconds) and the holding-day counter (o.hDone) are separate: 5-minute processing never increments hDone.
  function winStart(o, w) { return w === 0 ? o.submittedAtSec : o.dId + w * DAY; }
  function winEnd(o, w) { return o.dId + (w + 1) * DAY; }
  function dayOf(t) { return Math.floor(t / DAY) * DAY; }
  function bar5Ok(b) { return !!b && num(b.id) && b.id % BAR5 === 0 && num(b.open) && num(b.high) && num(b.low) && num(b.close) && b.low <= b.high && b.open >= b.low && b.open <= b.high && b.close >= b.low && b.close <= b.high; }
  // Per-coin intraday evidence: closed, well-formed 5-minute bars (bar usable only when id + 300 <= issueSec) and trade slices { fromSec, toSec, complete, trades:[{t,p,n?}] }.
  function indexIntraday(barsByCoin, capture) {
    var out = {}, issueSec = capture && num(capture.issueSec) ? capture.issueSec : null;
    Object.keys(barsByCoin || {}).forEach(function (cg) {
      var src = barsByCoin[cg] || {}, m = {};
      (src.bars5 || []).forEach(function (b) { if (bar5Ok(b) && (issueSec == null || b.id + BAR5 <= issueSec)) m[b.id] = b; });
      out[cg] = { bars: m, slices: Array.isArray(src.trades) ? src.trades : [] };
    });
    return out;
  }
  function ctxOf(barsByCoin, capture, opts) { return { daily: indexBars(barsByCoin), ev: indexIntraday(barsByCoin, capture), needs: (opts && opts.needs) || [] }; }
  function needOnce(ctx, n) {
    for (var i = 0; i < ctx.needs.length; i++) { var x = ctx.needs[i]; if (x.kind === n.kind && x.cgId === n.cgId && x.fromSec === n.fromSec && x.toSec === n.toSec && x.pair === n.pair) return; }
    ctx.needs.push(n);
  }
  // Trades over [lo, hi): { status: 'ok', list } | { status: 'unavailable' } | { status: 'need' }. Only a slice whose coverage reaches hi AND is marked complete can declare anything
  // (a no-event included); an incomplete slice (truncation, failed page, gap) is `unavailable`; no slice at all registers a need so the caller can fetch and re-run.
  function tradesFor(ctx, o, lo, hi) {
    var ev = ctx.ev[o.cgId], slices = ev ? ev.slices : [], bad = false;
    for (var i = 0; i < slices.length; i++) {
      var s = slices[i];
      if (!s || !(s.fromSec <= lo && s.toSec >= hi)) continue;
      if (s.complete !== true) { bad = true; continue; }
      var list = (s.trades || []).filter(function (x) { return x && num(x.t) && num(x.p) && x.t >= lo && x.t < hi; });
      list = list.map(function (x, k) { return { t: x.t, p: x.p, n: x.n != null ? x.n : k }; }).sort(function (a, b) { return a.t - b.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0); });
      return { status: 'ok', list: list };
    }
    if (bad) return { status: 'unavailable' };
    needOnce(ctx, { kind: 'trades', cgId: o.cgId, pair: o.pair || null, fromSec: lo, toSec: hi });
    return { status: 'need' };
  }
  function intradayOf(o) { if (!o.intraday) o.intraday = { granularity: BAR5, bars: [], trades: [] }; return o.intraday; }
  function pushBar5(o, bar) {
    var it = intradayOf(o), n = it.bars.length;
    if (n && it.bars[n - 1].id >= bar.id) return;
    it.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
  function storeSlice(o, role, lo, hi, list) {
    var it = intradayOf(o);
    it.trades.push({ role: role, fromSec: lo, toSec: hi, count: list.length, trades: list.slice(0, CFG.TRADES_STORE_MAX).map(function (x) { return [x.t, x.p]; }), truncated: list.length > CFG.TRADES_STORE_MAX });
  }
  // An interval that cannot be resolved from the evidence in hand. Entry: the order is `pending-unresolved` (reservation and slot held). Exit with a KNOWN fill: the position stays `open`
  // (one entry charge, ordinary open exposure, no reservation restored) with a separate unresolved-exit interval (Amendment §11 B1).
  function markUnresolved(book, o, capture, phase, fromSec, toSec, reason, ctx) {
    var prev = o.unresolved, same = prev && prev.phase === phase && prev.fromSec === fromSec && prev.reason === reason;
    o.unresolved = { phase: phase, fromSec: fromSec, toSec: toSec, reason: reason, sinceCaptureId: same ? prev.sinceCaptureId : capture.captureId, sinceDate: same ? prev.sinceDate : capture.date,
      captures: same ? (prev.lastCaptureId === capture.captureId ? prev.captures : prev.captures + 1) : 1, lastCaptureId: capture.captureId };
    if (phase === 'entry' && o.status === 'resting') setStatus(o, 'pending-unresolved');
    addEv(o, capture, 'unresolved', { barId: fromSec, k: phase + ':' + reason, step: 2 });
    if (ctx && reason === 'bars5-missing') needOnce(ctx, { kind: 'bars5', cgId: o.cgId, pair: o.pair || null, fromSec: fromSec, toSec: toSec });
  }
  function clearUnresolved(o, capture) {
    if (o.unresolved) { addEv(o, capture, 'resumed', { barId: o.unresolved.fromSec, k: o.unresolved.phase, step: 2 }); o.unresolved = null; }
    if (o.status === 'pending-unresolved') setStatus(o, 'resting');
  }

  // ---------- fills ----------
  // spec: { price, reason, kind, adverse, tSec, barId, dayId, daily, sizeProxy? }. Fee kind and adversity are RECORDED here and read everywhere else (never inferred from `reason`).
  function applyFill(book, o, spec, capture, step) {
    var a = book.accounts[o.policyId], n = notional(o.Q, o.lotsInv, spec.price), ch = sideCharges(n, spec.kind, spec.adverse, 'base');
    o.fill = { price: spec.price, barId: spec.barId, dayId: spec.dayId, tSec: spec.tSec, reason: spec.reason, kind: spec.kind, adverse: spec.adverse, notionalCents: n, feeCents: ch.feeCents, frictionCents: ch.frictionCents,
      captureId: capture.captureId, date: capture.date };
    if (spec.sizeProxy) o.fill.sizeProxy = spec.sizeProxy;
    a.cash -= n + ch.feeCents + ch.frictionCents;
    releaseReservation(book, o, capture, 'filled');
    setStatus(o, 'open');
    o.hDone = spec.daily ? 1 : 0; o.stale = { count: 0, persistent: false, mark: spec.price, markDate: capture.date };
    o.unresolved = null;
    addEv(o, capture, 'filled', { barId: spec.barId, price: spec.price, reason: spec.reason, step: step });
  }
  function exitNow(book, o, r, bar, capture) {   // primary exit and the identical sensitivity exit (no horizon bar can be reached on the fill day)
    primaryExit(book, o, r, bar, capture); o.sens.exit = exitRecord(o, r, bar, capture, 'base');
  }
  function primaryExit(book, o, r, bar, capture) {
    var a = book.accounts[o.policyId], rec = exitRecord(o, r, bar, capture, 'base');
    a.cash += rec.notionalCents - rec.feeCents - rec.frictionCents;
    o.exit = rec; setStatus(o, 'exited'); addEv(o, capture, 'exited', { barId: bar.id, reason: r.reason, price: r.price, step: 2 });
  }
  // fill-candle convention (§4.4, unamended): intrabar order unknown, a stop in the fill candle is honoured, no target credit.
  function fillCandleExit(o, bar, gapOpenFill) {
    if (gapOpenFill && bar.open <= o.S) return { reason: 'gap-stop-on-fill', price: bar.open, kind: 'taker', adverse: true };
    if (bar.low <= o.S) return { reason: 'ambiguous-stop', price: o.S, kind: 'taker', adverse: true };
    return null;
  }
  // First stop / target print in time order among the trades (Amendment §1: at/below S => stop; at/above T => target).
  function scanExitTrades(o, list) {
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (x.p <= o.S) return { reason: 'stop', price: o.S, kind: 'taker', adverse: false, tSec: x.t };
      if (x.p >= o.T) return { reason: 'target', price: o.T, kind: 'maker', adverse: false, tSec: x.t };
    }
    return null;
  }

  // ---------- step 2: adjudication ----------
  // Entry evidence for [cur, endEff) from 5-minute bars. Returns 'done' | 'filled' | 'unresolved'. The cursor only moves past an interval that is RESOLVED.
  function entryIntraday(book, o, ctx, capture, cur, endEff) {
    var ev = ctx.ev[o.cgId] || { bars: {}, slices: [] }, Lm = clean(o.L - o.tick), guard = 0;
    while (cur < endEff && guard++ < 400) {
      var b = Math.floor(cur / BAR5) * BAR5, bend = b + BAR5, segEnd = Math.min(bend, endEff), bar = ev.bars[b];
      if (!bar) { o.cursorSec = cur; markUnresolved(book, o, capture, 'entry', cur, endEff, 'bars5-missing', ctx); return 'unresolved'; }
      var partial = cur > b || segEnd < bend;
      if (!partial) {   // full bar: start >= submission and end <= the active interval's end
        var gap = bar.open < o.L, lim = !gap && bar.low <= Lm;
        if (gap || lim) {
          if (o.status === 'pending-unresolved') clearUnresolved(o, capture);
          pushBar5(o, bar);
          applyFill(book, o, { price: gap ? bar.open : o.L, reason: gap ? 'fill-gap-open' : 'limit', kind: gap ? 'taker' : 'maker', adverse: gap, tSec: b, barId: b, dayId: dayOf(b), daily: false }, capture, 2);
          var r = fillCandleExit(o, bar, gap);
          o.cursorSec = bend;
          if (r) { exitNow(book, o, r, bar, capture); o.hDone = 1; }
          return 'filled';
        }
        pushBar5(o, bar); cur = segEnd; o.cursorSec = cur; continue;
      }
      // partial bar (the submission-straddling bar, or a bar cut by a cancellation cutoff): its RANGE decides
      if (bar.low > Lm) { pushBar5(o, bar); cur = segEnd; o.cursorSec = cur; continue; }   // range clear of the barrier: no event
      var tr = tradesFor(ctx, o, cur, bend);   // whole remainder of the bar: the fill candle's stop check needs it
      if (tr.status !== 'ok') { o.cursorSec = cur; markUnresolved(book, o, capture, 'entry', cur, endEff, tr.status === 'need' ? 'trades-pending' : 'trades-unavailable', ctx); return 'unresolved'; }
      var fi = -1; for (var i = 0; i < tr.list.length; i++) { if (tr.list[i].t >= segEnd) break; if (tr.list[i].p <= Lm) { fi = i; break; } }
      storeSlice(o, 'entry', cur, bend, tr.list);
      if (fi < 0) { pushBar5(o, bar); cur = segEnd; o.cursorSec = cur; continue; }   // coverage reached the interval end and no print at/below L - tick
      if (o.status === 'pending-unresolved') clearUnresolved(o, capture);
      pushBar5(o, bar);
      applyFill(book, o, { price: o.L, reason: 'limit', kind: 'maker', adverse: false, tSec: tr.list[fi].t, barId: b, dayId: dayOf(b), daily: false }, capture, 2);
      o.cursorSec = bend;
      for (var j = fi; j < tr.list.length; j++) if (tr.list[j].p <= o.S) { exitNow(book, o, { reason: 'stop', price: o.S, kind: 'taker', adverse: false, tSec: tr.list[j].t }, bar, capture); o.hDone = 1; break; }
      return 'filled';
    }
    return 'done';
  }
  function adjudicateOrder(book, o, ctx, capture) {
    var guard = 0, byId = ctx.daily[o.cgId] || {};
    while (guard++ < 64) {
      if (o.status === 'resting' || o.status === 'pending-unresolved' || o.status === 'cancel-pending') {
        if (o.status === 'cancel-pending' && o.cursorSec >= o.cancelCutoffSec) { terminate(book, o, capture, 'cancelled-suspension', 'cancel-pending resolved unfilled', 2); return; }
        if (o.eligibleDone >= CFG.EXPIRY_BARS) { terminate(book, o, capture, o.status === 'cancel-pending' ? 'cancelled-suspension' : 'expired', 'eligible windows exhausted', 2); return; }
        var w = o.w0 + o.eligibleDone, ws = winStart(o, w), we = winEnd(o, w);
        var clipped = o.status === 'cancel-pending' && o.cancelCutoffSec < we, endEff = clipped ? o.cancelCutoffSec : we;
        if (endEff > capture.inputCutoffSec) return;   // the interval is not over yet: nothing is due (a bar that is not usable yet is not an unresolved one)
        var cur = o.cursorSec == null ? ws : o.cursorSec;
        if (w >= 1 && !clipped && cur === ws) {   // daily window
          var bar = byId[ws];
          if (!bar) { markUnresolved(book, o, capture, 'entry', ws, we, 'daily-bar-unavailable', ctx); return; }   // never advance past an unusable bar
          if (o.unresolved || o.status === 'pending-unresolved') clearUnresolved(o, capture);
          o.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
          var gapD = bar.open < o.L, limD = !gapD && bar.low <= clean(o.L - o.tick);   // no crossing rejection, no window-index guard: a bar opening below L fills at that open
          if (gapD || limD) {
            applyFill(book, o, { price: gapD ? bar.open : o.L, reason: gapD ? 'fill-gap-open' : 'limit', kind: gapD ? 'taker' : 'maker', adverse: gapD, tSec: ws, barId: bar.id, dayId: ws, daily: true }, capture, 2);
            var rd = fillCandleExit(o, bar, gapD); if (rd) { exitNow(book, o, rd, bar, capture); }
            o.nextBarId = null; positionPhase(book, o, ctx, capture); return;
          }
          o.eligibleDone++; o.cursorSec = we; o.nextBarId = o.dId + (o.w0 + o.eligibleDone) * DAY; addEv(o, capture, 'no-fill', { barId: bar.id, step: 2 });
          continue;
        }
        var res = entryIntraday(book, o, ctx, capture, cur, endEff);
        if (res === 'unresolved') return;
        if (res === 'filled') { o.nextBarId = null; positionPhase(book, o, ctx, capture); return; }
        if (o.unresolved || o.status === 'pending-unresolved') clearUnresolved(o, capture);
        addEv(o, capture, 'no-fill', { barId: ws, k: 'w' + w, step: 2 });
        if (clipped) { o.cursorSec = endEff; continue; }
        o.eligibleDone++; o.cursorSec = we; o.nextBarId = o.dId + (o.w0 + o.eligibleDone) * DAY;
        continue;
      }
      if (o.fill) positionPhase(book, o, ctx, capture);
      return;
    }
  }

  // Fill-day exit evidence from 5-minute bars (holding day 1). Returns 'done' | 'wait' | 'unresolved'. The first bar after an ask / trades fill is partial: its range decides, Trades when the range touches S or T.
  function positionIntraday(book, o, ctx, capture) {
    var dayEnd = o.fill.dayId + DAY;
    if (dayEnd > capture.inputCutoffSec) return 'wait';
    var ev = ctx.ev[o.cgId] || { bars: {}, slices: [] }, cur = o.cursorSec == null ? o.fill.tSec : o.cursorSec, guard = 0;
    while (cur < dayEnd && guard++ < 400) {
      var b = Math.floor(cur / BAR5) * BAR5, bend = b + BAR5, bar = ev.bars[b];
      if (!bar) { o.cursorSec = cur; markUnresolved(book, o, capture, 'exit', cur, dayEnd, 'bars5-missing', ctx); return 'unresolved'; }
      if (cur === b) {   // full bar: the normal open-first / stop-first race
        var r = exitRules(bar, o, false);
        pushBar5(o, bar);
        if (r) { exitNow(book, o, r, bar, capture); o.hDone = 1; o.cursorSec = dayEnd; clearUnresolved(o, capture); return 'done'; }
      } else {           // partial bar: only prints at/after the fill time count; the range decides, Trades when the range touches S or T
        if (bar.low <= o.S || bar.high >= o.T) {
          var tr = tradesFor(ctx, o, cur, bend);
          if (tr.status !== 'ok') { o.cursorSec = cur; markUnresolved(book, o, capture, 'exit', cur, dayEnd, tr.status === 'need' ? 'trades-pending' : 'trades-unavailable', ctx); return 'unresolved'; }
          storeSlice(o, 'exit', cur, bend, tr.list);
          var rt = scanExitTrades(o, tr.list);
          pushBar5(o, bar);
          if (rt) { exitNow(book, o, rt, bar, capture); o.hDone = 1; o.cursorSec = dayEnd; clearUnresolved(o, capture); return 'done'; }
        } else pushBar5(o, bar);
      }
      cur = bend; o.cursorSec = cur;
    }
    clearUnresolved(o, capture);
    o.hDone = 1; o.cursorSec = dayEnd;
    return 'done';
  }
  // Holding days 2..20 on daily bars, strictly sequential; holding day h is the daily bar fill.dayId + (h-1)*DAY, day 1 being the fill day itself. The 20-bar sensitivity is its own state.
  function positionPhase(book, o, ctx, capture) {
    var byId = ctx.daily[o.cgId] || {}, guard = 0;
    if (o.hDone === 0) { var pi = positionIntraday(book, o, ctx, capture); if (pi !== 'done') return; }
    while (o.hDone < CFG.RETAIN_BARS && guard++ < 32) {
      var h = o.hDone + 1, id = o.fill.dayId + (h - 1) * DAY, bar = byId[id];
      if (!bar) return;   // stall: no exit is adjudicated past an unusable bar
      o.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      if (!o.exit) { var r = exitRules(bar, o, h === CFG.HORIZON_BAR); if (r) primaryExit(book, o, r, bar, capture); }
      if (!o.sens.exit) { var r2 = exitRules(bar, o, h === CFG.RETAIN_BARS); if (r2) o.sens.exit = exitRecord(o, r2, bar, capture, 'base'); }
      o.hDone = h;
    }
  }
  // opts.needs (optional array) collects evidence the pipeline asked for and did not have: { kind: 'bars5' | 'trades', cgId, pair, fromSec, toSec }.
  function adjudicateAll(book, capture, barsByCoin, opts) {
    if (book.schemaVersion !== ORDERS_SCHEMA_VERSION) throw new Error('orders book schemaVersion ' + book.schemaVersion + ' != ' + ORDERS_SCHEMA_VERSION + ' (a v1.4.2 book is never carried into v1.4.3: the cohort restart resets)');
    var b = cloneBook(book), ctx = ctxOf(barsByCoin, capture, opts); curStep = 2;
    b.orders.forEach(function (o) { adjudicateOrder(b, o, ctx, capture); });
    curStep = null; return b;
  }

  // ---------- step 4: valuation ----------
  function admittedRiskCents(book, pid) {
    var s = 0;
    ordersOf(book, pid).forEach(function (o) {
      if (isPending(o)) s += plannedRiskCents(o);
      else if (isOpen(o)) s += notional(o.Q, o.lotsInv, Math.max(0, o.fill.price - o.S));
    });
    return s;
  }
  function valuation(book, pid, capture, barsByCoin) {
    var b = cloneBook(book); valuationInPlace(b, pid, capture, indexBars(barsByCoin)); return b;
  }
  // Also called mid-issuance (same capture) after an immediate fill: marks already written for this capture are reused (no second mark); the capture's series row is re-written.
  function valuationInPlace(b, pid, capture, idx) {
    var a = b.accounts[pid], marked = 0, anyStale = false;
    ordersOf(b, pid).forEach(function (o) {
      if (!isOpen(o)) return;
      var lastMark = o.marks.length ? o.marks[o.marks.length - 1] : null;
      if (lastMark && lastMark.captureId === capture.captureId) { marked += lastMark.valueCents; if (o.stale.count >= 1) anyStale = true; return; }   // valuation repeated for this capture: no second mark
      var bar = (idx[o.cgId] || {})[capture.inputCutoffSec - DAY];
      if (bar) { o.stale.count = 0; o.stale.persistent = false; o.stale.mark = bar.close; o.stale.markDate = capture.date; }
      else { o.stale.count++; if (o.stale.count >= CFG.STALE_PERSISTENT_AT) o.stale.persistent = true; anyStale = true; }
      var mv = notional(o.Q, o.lotsInv, o.stale.mark);
      o.marks.push({ date: capture.date, captureId: capture.captureId, mark: o.stale.mark, valueCents: mv, staleCount: o.stale.count });
      marked += mv;
    });
    var E = a.cash + marked;
    a.hwm = a.hwm == null ? E : Math.max(a.hwm, E);
    var risk = admittedRiskCents(b, pid);
    a.riskLimitExceeded = risk * 10000 > E * CFG.RISK_LIMIT_BP;
    var row = { date: capture.date, captureId: capture.captureId, cutoffSec: capture.inputCutoffSec, cash: a.cash, reserved: reservedSum(a), marked: marked, E: E, HWM: a.hwm, drawdown: a.hwm > 0 ? (a.hwm - E) / a.hwm : 0,
      suspended: a.suspended, riskLimitExceeded: a.riskLimitExceeded, staleMark: anyStale, blockedReason: null };
    var i = a.series.length - 1; if (i >= 0 && a.series[i].captureId === capture.captureId) a.series[i] = row; else a.series.push(row);
    a.lastValuation = { captureId: capture.captureId, date: capture.date, E: E, HWM: a.hwm };
    return row;
  }

  // ---------- step 5: suspension (§5.5) ----------
  function suspend(book, pid, capture) {
    var b = cloneBook(book), a = b.accounts[pid], v = a.lastValuation;
    if (!v || v.captureId !== capture.captureId) throw new Error('valuation() must run before suspend()');
    suspendInPlace(b, pid, capture, capture.inputCutoffSec);
    return b;
  }
  // cutSec: the suspension cutoff. Step 5: the capture's input cutoff. Mid-capture (after an immediate fill, step 7): t_sub of the fill that caused it (Amendment §2).
  function suspendInPlace(b, pid, capture, cutSec) {
    var a = b.accounts[pid], v = a.lastValuation, prevStep = curStep; curStep = 5;
    if (!a.suspended && v.HWM > 0 && (v.HWM - v.E) * CFG.DD_SUSPEND_DEN >= CFG.DD_SUSPEND_NUM * v.HWM) {
      a.suspended = true; a.suspendedAt = capture.date; a.suspensionCutoffSec = cutSec;
      var last = a.series[a.series.length - 1]; if (last && last.captureId === capture.captureId) last.suspended = true;
      ordersOf(b, pid).forEach(function (o) {
        if (o.status === 'resting') {
          // every window that opens before the cutoff must already be adjudicated (usable) and unfilled; windows are [t_sub, end D], D+1, D+2 and open at their start
          var pre = firstPreCutoffUnadjudicated(o, cutSec);
          if (pre == null) terminate(b, o, capture, 'cancelled-suspension', 'suspension', 5);
          else { setStatus(o, 'cancel-pending'); o.cancelCutoffSec = cutSec; addEv(o, capture, 'cancel-pending', { cutoff: cutSec, step: 5 }); }
          return;
        }
        if (o.status === 'pending-unresolved') { setStatus(o, 'cancel-pending'); o.cancelCutoffSec = cutSec; addEv(o, capture, 'cancel-pending', { cutoff: cutSec, step: 5 }); }
      });
    }
    curStep = prevStep;
  }
  function firstPreCutoffUnadjudicated(o, cut) {
    for (var w = o.w0 + o.eligibleDone; w < o.w0 + CFG.EXPIRY_BARS; w++) { var st = winStart(o, w); if (st < cut) return st; }
    return null;
  }

  // ---------- step 7: issuance (§4.1, §5.3, §5.4) ----------
  // Item 40: tolPct > 0 widens the UPPER edge only: entryLow <= price <= entryHigh x (1 + tolPct/100). tolPct 0 / absent is the original test, bit for bit.
  function zoneTol(tolPct) { return num(tolPct) && tolPct > 0 ? tolPct : 0; }
  function policyTol(policy) { return zoneTol(policy && policy.zoneTolerancePct); }
  function inZoneTol(cand, tolPct) { var ez = cand.entryEconomics && cand.entryEconomics.entryZone, t = zoneTol(tolPct); return !!(ez && num(ez[0]) && num(ez[1]) && num(cand.price) && cand.price >= ez[0] && cand.price <= (t > 0 ? ez[1] * (1 + t / 100) : ez[1])); }
  function inZone(cand) { return inZoneTol(cand, 0); }
  // Challenger predicate (Protocol v1.3 §5.1): { minScore, minNetRR, requiredGates: [gate ids that must pass], excludeStopBasis: [stopBasis strings] }, inheriting N0's screen AND in-zone
  // condition. An empty or absent configuration never qualifies (C1 not configured). Version and other keys are labels only.
  function challengerActive(ch) {
    return !!ch && (num(ch.minScore) || num(ch.minNetRR) || (Array.isArray(ch.requiredGates) && ch.requiredGates.length > 0) || (Array.isArray(ch.excludeStopBasis) && ch.excludeStopBasis.length > 0));
  }
  // Configuration errors (checked at startup by capture.js against the detector's gate ids; any error aborts the capture as an extra capture, so nothing is ever issued).
  function validateChallenger(ch, knownGateIds) {
    var errs = [];
    if (ch == null) return errs;
    if (typeof ch !== 'object' || Array.isArray(ch)) return ['challenger must be an object'];
    if (ch.minScore != null && !num(ch.minScore)) errs.push('minScore must be a finite number');
    if (ch.minNetRR != null && !num(ch.minNetRR)) errs.push('minNetRR must be a finite number');
    if (ch.requiredGates != null) {
      if (!Array.isArray(ch.requiredGates)) errs.push('requiredGates must be an array of gate ids');
      else ch.requiredGates.forEach(function (g) { if (typeof g !== 'string' || (knownGateIds && knownGateIds.indexOf(g) < 0)) errs.push('unknown gate id: ' + JSON.stringify(g)); });
    }
    if (ch.zoneTolerancePct != null && !(num(ch.zoneTolerancePct) && ch.zoneTolerancePct >= 0)) errs.push('zoneTolerancePct must be a finite number >= 0');
    if (ch.excludeStopBasis != null) {
      if (!Array.isArray(ch.excludeStopBasis)) errs.push('excludeStopBasis must be an array of stopBasis strings');
      else ch.excludeStopBasis.forEach(function (b) { if (typeof b !== 'string') errs.push('excludeStopBasis entries must be strings'); });
    }
    return errs;
  }
  // tolPct (item 40, optional): when > 0 the required gate C2.entry-zone is decided by inZoneTol(cand, tolPct); the logged gate row is only read (it must exist), never modified.
  function qualify(ch, cand, tolPct) {
    if (!challengerActive(ch)) return false;
    if (num(ch.minScore) && !(num(cand.score) && cand.score >= ch.minScore)) return false;
    if (num(ch.minNetRR) && !(cand.entryEconomics && num(cand.entryEconomics.netRR) && cand.entryEconomics.netRR >= ch.minNetRR)) return false;
    if (Array.isArray(ch.requiredGates)) {
      var gates = Array.isArray(cand.gates) ? cand.gates : [];
      for (var i = 0; i < ch.requiredGates.length; i++) {
        var id = ch.requiredGates[i], g = null;
        for (var j = 0; j < gates.length; j++) if (gates[j] && gates[j].id === id) { g = gates[j]; break; }
        if (!g) return false;   // a listed gate that is absent from the log row does not pass
        if (zoneTol(tolPct) > 0 && id === 'C2.entry-zone') { if (!inZoneTol(cand, tolPct)) return false; continue; }
        if (g.pass !== true) return false;
      }
    }
    if (Array.isArray(ch.excludeStopBasis) && ch.excludeStopBasis.length && cand.entryEconomics && ch.excludeStopBasis.indexOf(cand.entryEconomics.stopBasis) >= 0) return false;
    return true;
  }
  function predicateHolds(policy, cand, cfg) {
    var tol = policyTol(policy);
    if (!(cand.screen && cand.screen.pass) || !(tol > 0 ? inZoneTol(cand, tol) : inZone(cand))) return false;
    if (policy.id === 'N0') return true;
    return tol > 0 ? qualify(cfg && cfg.challenger, cand, tol) : qualify(cfg && cfg.challenger, cand);   // C1: no configuration -> never qualifies
  }
  // Protocol v1.4.4 R5: observation only - the same three tests as predicateHolds, evaluated WITHOUT short-circuit so a silent non-attempt can be recorded with its inputs.
  // Never read by the engine; issueOne calls it only when cfg.observeSilent is set.
  function predicateDiagnosis(policy, cand, cfg) {
    var ee = cand.entryEconomics, ez = ee && ee.entryZone, lo = ez && num(ez[0]) ? ez[0] : null, hi = ez && num(ez[1]) ? ez[1] : null, px = num(cand.price) ? cand.price : null;
    var dist = null; if (px != null && lo != null && hi != null) dist = px < lo ? (px - lo) / lo * 100 : (px > hi ? (px - hi) / hi * 100 : 0);
    var tol = policyTol(policy), screenPass = !!(cand.screen && cand.screen.pass), zone = tol > 0 ? inZoneTol(cand, tol) : inZone(cand), q = null, failed = [];
    if (policy.id !== 'N0') {
      var ch = cfg && cfg.challenger, active = challengerActive(ch), fails = [];
      if (active) {
        if (num(ch.minScore) && !(num(cand.score) && cand.score >= ch.minScore)) fails.push('minScore');
        if (num(ch.minNetRR) && !(ee && num(ee.netRR) && ee.netRR >= ch.minNetRR)) fails.push('minNetRR');
        if (Array.isArray(ch.requiredGates)) {
          var gates = Array.isArray(cand.gates) ? cand.gates : [];
          ch.requiredGates.forEach(function (id) { var g = null; for (var j = 0; j < gates.length; j++) if (gates[j] && gates[j].id === id) { g = gates[j]; break; } if (!g || !(tol > 0 && id === 'C2.entry-zone' ? inZoneTol(cand, tol) : g.pass === true)) fails.push(id); });
        }
        if (Array.isArray(ch.excludeStopBasis) && ch.excludeStopBasis.length && ee && ch.excludeStopBasis.indexOf(ee.stopBasis) >= 0) fails.push('excludeStopBasis');
      }
      q = { active: active, pass: active && fails.length === 0, failing: fails };
    }
    if (!screenPass) failed.push('screen'); if (!zone) failed.push('in-zone'); if (q && !q.pass) failed.push('qualify');
    return { failed: failed, screen: { pass: screenPass, reasons: (cand.screen && cand.screen.reasons) || [], widthPrice: cand.screen && cand.screen.widthPrice !== undefined ? cand.screen.widthPrice : null, width: cand.screen && cand.screen.width !== undefined ? cand.screen.width : null },
      zone: tol > 0 ? { pass: zone, price: px, entryLow: lo, entryHigh: hi, distancePct: dist, tolPct: tol } : { pass: zone, price: px, entryLow: lo, entryHigh: hi, distancePct: dist }, qualify: q };
  }
  function staleBlocked(book, pid) {
    return ordersOf(book, pid).some(function (o) { return isOpen(o) && o.stale && o.stale.count >= 1 && !o.stale.persistent; });
  }
  // Capacity (§5.4): slots incl. this order, admitted risk incl. this order, free cash. `pend`/`opn` = arrays of order-like {Q,lotsInv,L,S,fill?}.
  function capacityOk(pendList, openList, cash, reserved, E, thisRiskCents, thisRes) {
    if (pendList.length + openList.length + 1 > CFG.SLOTS) return 'slots';
    var risk = thisRiskCents;
    pendList.forEach(function (o) { risk += plannedRiskCents(o); });
    openList.forEach(function (o) { risk += notional(o.Q, o.lotsInv, Math.max(0, o.fill.price - o.S)); });
    if (risk * 10000 > E * CFG.RISK_LIMIT_BP) return 'risk';
    if (cash - reserved < thisRes) return 'cash';
    return null;
  }
  function metaOk(m) { return m && num(m.tick) && m.tick > 0 && num(m.lot) && m.lot > 0 && num(m.minOrder) && m.minOrder > 0; }

  function issueOne(b, policy, cand, capture, cfg, results) {
    var pid = policy.id, a = b.accounts[pid];
    for (var i = 0; i < b.attempts.length; i++) if (b.attempts[i].policyId === pid && b.attempts[i].episodeId === cand.episodeId) {   // one attempt per (policy, episode)
      if (cfg && cfg.observeSilent) { var pa = b.attempts[i]; results.push({ episodeId: cand.episodeId, outcome: 'attempt-already-consumed', consumed: false, prior: { captureId: pa.captureId, date: pa.date, outcome: pa.outcome, orderId: pa.orderId || null } }); }
      return;
    }
    if (!predicateHolds(policy, cand, cfg)) {                                         // no consumption
      if (cfg && cfg.observeSilent) results.push({ episodeId: cand.episodeId, outcome: 'predicate-false', consumed: false, diagnosis: predicateDiagnosis(policy, cand, cfg) });
      return;
    }
    if (cand.venueEligible === false || !metaOk(cand.meta)) { results.push({ episodeId: cand.episodeId, outcome: cand.venueEligible === false ? 'ineligible-venue' : 'ineligible-metadata', consumed: false }); return; }
    var ee = cand.entryEconomics;
    if (ee.stopBasis == null || ee.targetSource == null) throw new Error('log row lacks stopBasis/targetSource for ' + cand.cgId);
    var attempt = { policyId: pid, policyVersion: policy.version, episodeId: cand.episodeId, cgId: cand.cgId, captureId: capture.captureId, date: capture.date, outcome: null, orderId: null };
    var tolPct = policyTol(policy);
    if (tolPct > 0) {   // item 40: the audit record of the one thing the shadow policy changes
      var zg = null, gs = Array.isArray(cand.gates) ? cand.gates : []; for (var zi = 0; zi < gs.length; zi++) if (gs[zi] && gs[zi].id === 'C2.entry-zone') { zg = gs[zi]; break; }
      var zhi = ee.entryZone[1];
      attempt.zoneOverride = { tolPct: tolPct, loggedPass: !!(zg && zg.pass === true), price: cand.price, entryHigh: zhi, marginPct: (cand.price - zhi) / zhi * 100 };
    }
    b.attempts.push(attempt);
    var open = [], pend = [];
    ordersOf(b, pid).forEach(function (o) { if (isPending(o)) pend.push(o); else if (isOpen(o)) open.push(o); });
    // 1. exposure
    if (pend.concat(open).some(function (o) { return o.cgId === cand.cgId; })) { attempt.outcome = 'skipped-exposure'; results.push({ episodeId: cand.episodeId, outcome: attempt.outcome, consumed: true }); return; }
    // 2. levels and quantity
    var tick = cand.meta.tick, lot = cand.meta.lot, minOrder = cand.meta.minOrder, lotsInv = Math.round(1 / lot);
    var L = floorTo((ee.entryZone[0] + ee.entryZone[1]) / 2, tick), T = num(ee.target) ? floorTo(ee.target, tick) : null, S = num(ee.stop) ? ceilTo(ee.stop, tick) : null;
    if (!(S != null && T != null && S > 0 && S < L && L < T)) { attempt.outcome = 'rejected-levels'; results.push({ episodeId: cand.episodeId, outcome: attempt.outcome, consumed: true }); return; }
    var Eissue = a.lastValuation.E, Bc = Math.floor((2 * Eissue * CFG.BUDGET_BP + 10000) / 20000), third = Math.floor(Eissue / 3);
    var feeReserve = Math.floor((2 * third * CFG.FEE_RESERVE_BP + 10000) / 20000);
    var qA = (Bc / 100) / (L - S), qB = ((third - feeReserve) / 100) / L;
    var qLots = Math.floor(Math.min(qA, qB) * lotsInv + 1e-9), sizeClipped = qB < qA;
    if (!(qLots >= 1) || qLots / lotsInv < minOrder - 1e-12) { attempt.outcome = 'rejected-min-order'; results.push({ episodeId: cand.episodeId, outcome: attempt.outcome, consumed: true }); return; }
    var N = notional(qLots, lotsInv, L), res = N + feeReserve;
    // 3. capacity
    var why = capacityOk(pend, open, a.cash, reservedSum(a), Eissue, notional(qLots, lotsInv, L - S), res);
    if (why) { attempt.outcome = 'skipped-capacity'; attempt.reason = why; results.push({ episodeId: cand.episodeId, outcome: attempt.outcome, consumed: true, reason: why }); return; }
    // ---- freeze B / Q / L / S / T at t_dec (done above); only then take the submission-time snapshot (Amendment §2) ----
    b.seq++;
    var q = cfg && cfg.quotes ? cfg.quotes[cand.pair] : null, tDec = num(capture.issueSec) ? capture.issueSec : null;
    if (!q && cfg && cfg.needs && cand.pair) needOncePair(cfg.needs, cand.pair);
    var qOk = !!q && !q.missing && num(q.tSubSec) && num(q.quoteObservedAtSec) && num(q.ask) && q.ask > 0 && q.quoteObservedAtSec <= q.tSubSec && q.tSubSec - q.quoteObservedAtSec <= CFG.QUOTE_MAX_AGE_SEC && (tDec == null || q.tSubSec >= tDec);
    var tSub = q && num(q.tSubSec) && (tDec == null || q.tSubSec >= tDec) ? q.tSubSec : (tDec != null ? tDec : capture.inputCutoffSec);   // never earlier than t_dec; never "midnight"
    var o = { id: pid + '-' + capture.date + '-' + cand.cgId, seq: b.seq, policyId: pid, policyVersion: policy.version, episodeId: cand.episodeId, cgId: cand.cgId, pair: cand.pair || null,
      captureId: capture.captureId, issueDate: capture.date, issueTimeUtc: capture.issueTimeUtc || null, tDecSec: tDec, dId: capture.inputCutoffSec,
      submittedAtSec: tSub, quoteObservedAtSec: qOk ? q.quoteObservedAtSec : (q && num(q.quoteObservedAtSec) ? q.quoteObservedAtSec : null), quoteStatus: qOk ? 'ok' : 'quote-missing',
      quote: qOk ? { ask: q.ask, bid: num(q.bid) ? q.bid : null, last: num(q.last) ? q.last : null } : null,
      L: L, S: S, T: T, tick: tick, lot: lot, lotsInv: lotsInv, minOrder: minOrder, Bcents: Bc, Eissue: Eissue, Q: qLots, qty: qLots / lotsInv, Ncents: N, feeReserveCents: feeReserve, sizeClipped: sizeClipped,
      stopBasis: ee.stopBasis, targetSource: ee.targetSource, score: num(cand.score) ? cand.score : null,
      charges: { makerBp: CFG.MAKER_BP, takerBp: CFG.TAKER_BP, frictionBaseBp: CFG.FRICTION_BASE_BP, frictionAdverseBp: CFG.FRICTION_ADVERSE_BP }, expiryBar: CFG.EXPIRY_BARS,
      status: 'resting', events: [], bars: [], intraday: null, w0: 0, eligibleDone: 0, nextBarId: capture.inputCutoffSec, cursorSec: tSub, hDone: 0, fill: null, exit: null, sens: { exit: null }, marks: [], stale: null, cancelCutoffSec: null, unresolved: null, proxy: null };
    if (cfg && cfg.dailyProxy) { o.w0 = 1; o.cursorSec = o.dId + DAY; o.nextBarId = o.dId + DAY; o.proxy = 'daily-no-intraday'; }   // replay / calibration only: windows D+1..D+3, counterfactual
    o.expiryAtSec = o.dId + (o.w0 + CFG.EXPIRY_BARS) * DAY;   // expiry time (end of D+2) is recorded apart from the capture that adjudicates it
    a.reservations.push({ orderId: o.id, cents: res });
    addEv(o, capture, 'issued', { step: 7 }); addEv(o, capture, 'reservation-made', { cents: res, step: 7 });
    addEv(o, capture, 'submitted', { barId: tSub, k: o.quoteStatus, step: 7 });
    b.orders.push(o); attempt.outcome = 'order'; attempt.orderId = o.id;
    var result = { episodeId: cand.episodeId, outcome: 'order', consumed: true, orderId: o.id };
    if (!cfg || !cfg.dailyProxy) {
      // a. quote missing / stale: the order rests at L from the attempted-fetch time, no immediate fill; b. already through its stop; c. ask at/below L: fill now at the ask (taker, adverse); d. rest
      if (qOk && q.ask <= S) {
        terminate(b, o, capture, 'rejected-invalid-at-submission', 'ask at/below S at submission', 7); attempt.outcome = 'rejected-invalid-at-submission'; result.outcome = 'rejected-invalid-at-submission'; results.push(result); return;
      }
      if (qOk && q.ask <= L) {
        applyFill(b, o, { price: q.ask, reason: 'fill-crossing-ask', kind: 'taker', adverse: true, tSec: tSub, barId: tSub, dayId: dayOf(tSub), daily: false, sizeProxy: 'top-of-book' }, capture, 7);
        o.marks.push({ date: capture.date, captureId: capture.captureId, mark: q.ask, valueCents: notional(o.Q, o.lotsInv, q.ask), staleCount: 0 });   // marked at its fill price
        valuationInPlace(b, pid, capture, {});                                                                                                          // cash, marked, E, HWM, drawdown, risk flag, series row
        result.filled = 'fill-crossing-ask';
        suspendInPlace(b, pid, capture, tSub);                                                                                                          // in-sequence suspension: cutoff = this fill's t_sub
      }
    }
    results.push(result);
  }
  function needOncePair(needs, pair) { for (var i = 0; i < needs.length; i++) if (needs[i].kind === 'ticker' && needs[i].pair === pair) return; needs.push({ kind: 'ticker', pair: pair }); }
  // candidates: [{ episodeId, cgId, pair, screen:{pass}, price, score, entryEconomics:{entryZone,stop,target,stopBasis,targetSource,netRR}, venueEligible, meta:{tick,lot,minOrder} }]
  // cfg.quotes[pair] = { tSubSec, quoteObservedAtSec, ask, bid, last } | { tSubSec, missing: true }. Sequence per order: freeze -> snapshot -> checks -> account update -> next candidate.
  function issueBatch(book, policy, candidates, capture, cfg) {
    var b = cloneBook(book), a = b.accounts[policy.id], results = [];
    if (!a.lastValuation || a.lastValuation.captureId !== capture.captureId) throw new Error('valuation() must run at step 4 of this capture before issueBatch()');
    var blocked = a.suspended ? 'suspended' : (staleBlocked(b, policy.id) ? 'skipped-stale-mark' : null);
    var row = a.series[a.series.length - 1]; if (row && row.captureId === capture.captureId) row.blockedReason = blocked;
    if (blocked) return { book: b, results: [], blockedReason: blocked };
    curStep = 7;
    var list = (candidates || []).slice().sort(function (x, y) { var sx = num(x.score) ? x.score : -Infinity, sy = num(y.score) ? y.score : -Infinity; return sy - sx || (x.cgId < y.cgId ? -1 : x.cgId > y.cgId ? 1 : 0); });
    var midSuspended = false;
    for (var i = 0; i < list.length; i++) {
      if (a.suspended) { midSuspended = true; break; }   // suspension fired in-sequence: later candidates in this capture are not issued (no attempt consumed)
      issueOne(b, policy, list[i], capture, cfg || {}, results);
    }
    if (a.suspended) { var r2 = a.series[a.series.length - 1]; if (r2 && r2.captureId === capture.captureId) r2.blockedReason = 'suspended-mid-capture'; }
    curStep = null;
    return { book: b, results: results, blockedReason: midSuspended ? 'suspended-mid-capture' : null };
  }

  // ---------- obligations (§3) ----------
  function obligations(book) {
    var out = [];
    book.orders.forEach(function (o) {
      var rem = 0;
      if (o.status === 'resting' || o.status === 'pending-unresolved') rem = CFG.EXPIRY_BARS - o.eligibleDone;
      else if (o.status === 'cancel-pending') { rem = 0; for (var k = o.w0 + o.eligibleDone; k < o.w0 + CFG.EXPIRY_BARS; k++) if (winStart(o, k) < o.cancelCutoffSec) rem++; }
      else if (o.fill) rem = CFG.RETAIN_BARS - o.hDone;
      if (rem > 0) out.push({ orderId: o.id, episodeId: o.episodeId, cgId: o.cgId, policyId: o.policyId, remainingBars: rem });
    });
    return out;
  }
  function exposureCoins(book) { var s = {}; book.orders.forEach(function (o) { if (isPending(o) || isOpen(o)) s[o.cgId] = 1; }); return Object.keys(s).sort(); }

  // ---------- §6 scenarios (counterfactual namespace; the factual book is never modified) ----------
  // Unresolved at the deadline: pending-unresolved / cancel-pending (unknown ENTRY), or an OPEN position whose exit interval is not usable (unknown EXIT; fill, charge and exposure stand).
  // Factual resolution from bars usable by the deadline (S3) is applied first by the caller (adjudicateAll on the lock dataset).
  function barOf(o, id) { for (var i = 0; i < o.bars.length; i++) if (o.bars[i].id === id) return o.bars[i]; return null; }
  function classifyUnresolved(o, ctx) {
    if (o.status === 'pending-unresolved' || o.status === 'cancel-pending') {
      // the unknown ENTRY interval: from the unresolved cursor to the end of its window (clipped at a cancellation cutoff)
      var w = o.w0 + o.eligibleDone, from = o.unresolved ? o.unresolved.fromSec : (o.cursorSec == null ? winStart(o, w) : o.cursorSec), to = o.unresolved ? o.unresolved.toSec : winEnd(o, w);
      return { row: 2, kind: o.status, missingBarId: dayOf(from), fromSec: from, toSec: to };
    }
    if (o.status === 'open') {
      if (o.hDone === 0) {   // known fill, fill-day exit interval not yet resolved: an OPEN position with an unresolved-exit cursor (no purchase, no reservation, no unfilled-expiry reclassification)
        var dayEnd = o.fill.dayId + DAY, cur = o.cursorSec == null ? o.fill.tSec : o.cursorSec;
        if (dayEnd <= ctx.deadlineSec) return { row: 3, kind: 'open-exit-unresolved', intraday: true, fromSec: cur, toSec: dayEnd, missingBarId: null, lastUsableId: null };
        return { row: 4, kind: 'open-horizon-not-reached', intraday: true, fromSec: cur, toSec: dayEnd, lastUsableId: null };
      }
      var nb = o.fill.dayId + o.hDone * DAY;
      if (nb + DAY <= ctx.deadlineSec) return { row: 3, kind: 'open-exit-unresolved', missingBarId: nb, lastUsableId: nb - DAY };
      return { row: 4, kind: 'open-horizon-not-reached', lastUsableId: nb - DAY };
    }
    return null;
  }
  // last adjudicated 5-minute close at/after the fill (never a bar that predates the position)
  function lastIntradayClose(o) { var it = o.intraday ? o.intraday.bars : []; for (var i = it.length - 1; i >= 0; i--) if (it[i].id + BAR5 > o.fill.tSec) return { price: it[i].close, tSec: it[i].id + BAR5 }; return null; }
  // Resolution of one unresolved order under scenario S ('S1' stress | 'S2' primary): { kind, tsSec, exit? , entry? }. Every timestamp is >= the order's submission instant.
  function resolveOrder(o, cls, S, ctx) {
    var dl = ctx.deadlineSec;
    if (cls.row === 2) {
      if (S === 'S1') return { kind: 'filled-stopped', tsSec: cls.toSec, entryPrice: o.L, exitPrice: o.S, barId: cls.missingBarId };
      return { kind: o.status === 'cancel-pending' ? 'cancelled-suspension' : 'expired', tsSec: dl };
    }
    if (cls.intraday) {
      var li = lastIntradayClose(o);
      if (cls.row === 3) {
        if (S === 'S1') return { kind: 'exit-at-zero', tsSec: cls.toSec, exitPrice: 0, barId: null };
        return { kind: 'exit-at-last-usable-close', tsSec: li ? li.tSec : o.fill.tSec, exitPrice: li ? li.price : o.fill.price, barId: null };
      }
      return { kind: 'exit-at-last-usable-close', tsSec: li ? li.tSec : o.fill.tSec, exitPrice: li ? li.price : o.fill.price, barId: null, row4: true };
    }
    var lastBar = barOf(o, cls.lastUsableId);
    if (cls.row === 3) {
      if (S === 'S1') return { kind: 'exit-at-zero', tsSec: cls.missingBarId + DAY, exitPrice: 0, barId: cls.missingBarId };
      return { kind: 'exit-at-last-usable-close', tsSec: cls.lastUsableId + DAY, exitPrice: lastBar ? lastBar.close : o.fill.price, barId: cls.lastUsableId };
    }
    // row 4 (not reachable under the section 7 timestamps): both scenarios exit at the last adjudicated bar's close, taker + adverse friction
    return { kind: 'exit-at-last-usable-close', tsSec: cls.lastUsableId + DAY, exitPrice: lastBar ? lastBar.close : o.fill.price, barId: cls.lastUsableId, row4: true };
  }
  function unresolvedOf(book, pid, ctx) {
    var out = [];
    ordersOf(book, pid).forEach(function (o) { var c = classifyUnresolved(o, ctx); if (c) out.push({ orderId: o.id, cls: c, S1: resolveOrder(o, c, 'S1', ctx), S2: resolveOrder(o, c, 'S2', ctx) }); });
    return out;
  }
  function rowIndexAtOrAfter(rows, tsSec) { for (var i = 0; i < rows.length; i++) if (rows[i].cutoffSec >= tsSec) return i; return rows.length - 1; }   // clamp to the last record (min(394, d))
  function pathAdmission(pendList, openList, cash, reserved, E, o, suspended, coinsHeld) {
    if (suspended) return 'scenario-suspension';
    if (coinsHeld[o.cgId]) return 'exposure';
    var why = capacityOk(pendList, openList, cash, reserved, E, plannedRiskCents(o), o.Ncents + o.feeReserveCents);
    return why ? ({ slots: 'slots', risk: 'risk', cash: 'cash' })[why] : null;
  }
  // One account path for policy `pid` under scenario S ('S1'|'S2') and cost mode ('base'|'allAdverse'). Replays the factual timeline (factual issuance decisions,
  // each order's L, S, T, Q and B_issue UNCHANGED); only the resolution of unresolved orders, the charges and admissibility against the path's own state differ.
  function replayPath(book, pid, S, mode, ctx, unresolved) {
    var acct = book.accounts[pid], rows = acct.series, orders = ordersOf(book, pid).slice().sort(function (x, y) { return x.seq - y.seq; });
    var st = { cash: acct.startCash, resv: {}, pend: {}, open: {}, excl: {}, suspended: false, hwm: null };
    var out = { series: [], trades: [], inadmissible: [], resolutions: [], suspendedAt: null }, byId = {}, resAt = {};
    orders.forEach(function (o) { byId[o.id] = o; });
    unresolved.forEach(function (u) { var r = u[S], i = rowIndexAtOrAfter(rows, r.tsSec); (resAt[i] = resAt[i] || []).push({ u: u, r: r }); });
    function evsAt(o, date, steps) { return o.events.filter(function (e) { return e.date === date && steps.indexOf(e.step) >= 0; }); }
    function releaseRes(id) { if (st.resv[id] != null) { delete st.resv[id]; } delete st.pend[id]; }
    function resSum() { var s = 0; Object.keys(st.resv).forEach(function (k) { s += st.resv[k]; }); return s; }
    function listOf(m) { return Object.keys(m).map(function (k) { return byId[k]; }); }
    function exclude(o, reason, date) { if (!st.excl[o.id]) { st.excl[o.id] = reason; out.inadmissible.push({ orderId: o.id, reason: reason, date: date }); } releaseRes(o.id); delete st.open[o.id]; }
    function entryCharges(o) { var f = o.fill; return sideCharges(f.notionalCents, f.kind, f.adverse, mode); }   // kind / adverse RECORDED on the fill, never inferred from the reason
    function applyFill(o, date) { var f = o.fill, ch = entryCharges(o); st.cash -= f.notionalCents + ch.feeCents + ch.frictionCents; delete st.pend[o.id]; st.open[o.id] = { entry: ch }; }
    function applyExit(o, date, e, kind) {   // factual exit e = o.exit
      var ch = sideCharges(e.notionalCents, e.kind, e.adverse, mode), en = st.open[o.id] ? st.open[o.id].entry : entryCharges(o);
      st.cash += e.notionalCents - ch.feeCents - ch.frictionCents; delete st.open[o.id];
      var pnl = e.notionalCents - ch.feeCents - ch.frictionCents - (o.fill.notionalCents + en.feeCents + en.frictionCents);
      out.trades.push({ orderId: o.id, cgId: o.cgId, kind: 'factual', reason: e.reason, filled: true, pnlCents: pnl, budgetR: pnl / o.Bcents, plannedRiskR: pnl / plannedRiskCents(o), attributionDate: date, fillDate: o.fill.date });
    }
    function applyResolution(x, date) {
      var o = byId[x.u.orderId], r = x.r; if (st.excl[o.id]) return;
      out.resolutions.push({ orderId: o.id, row: x.u.cls.row, scenario: S, kind: r.kind, tsSec: r.tsSec, recordDate: date });
      if (r.kind === 'skipped-missing-input' || r.kind === 'expired' || r.kind === 'cancelled-suspension') { releaseRes(o.id); return; }
      if (r.kind === 'filled-stopped') {
        var en = notional(o.Q, o.lotsInv, r.entryPrice), ex = notional(o.Q, o.lotsInv, r.exitPrice), chE = sideCharges(en, 'taker', true, 'allAdverse'), chX = sideCharges(ex, 'taker', true, 'allAdverse');
        st.cash += -en - chE.feeCents - chE.frictionCents + ex - chX.feeCents - chX.frictionCents; releaseRes(o.id);
        var pnl1 = ex - chX.feeCents - chX.frictionCents - en - chE.feeCents - chE.frictionCents;
        out.trades.push({ orderId: o.id, cgId: o.cgId, kind: 'scenario', reason: 'S1-filled-stopped', filled: true, pnlCents: pnl1, budgetR: pnl1 / o.Bcents, plannedRiskR: pnl1 / plannedRiskCents(o), attributionDate: date, fillDate: date });
        return;
      }
      var exN = notional(o.Q, o.lotsInv, r.exitPrice), chX2 = sideCharges(exN, 'taker', true, 'allAdverse'), en2 = st.open[o.id] ? st.open[o.id].entry : entryCharges(o);
      st.cash += exN - chX2.feeCents - chX2.frictionCents; delete st.open[o.id];
      var pnl2 = exN - chX2.feeCents - chX2.frictionCents - (o.fill.notionalCents + en2.feeCents + en2.frictionCents);
      out.trades.push({ orderId: o.id, cgId: o.cgId, kind: 'scenario', reason: 'S-' + r.kind, filled: true, pnlCents: pnl2, budgetR: pnl2 / o.Bcents, plannedRiskR: pnl2 / plannedRiskCents(o), attributionDate: date, fillDate: o.fill.date });
    }
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri], date = row.date;
      // step 2: factual adjudication events in order-seq order (step 3 is retired in v1.4.3)
      orders.forEach(function (o) {
        if (st.excl[o.id]) return;
        evsAt(o, date, [2]).forEach(function (e) {
          if (e.type === 'reservation-released') releaseRes(o.id);
          else if (e.type === 'filled') applyFill(o, date);
          else if (e.type === 'exited') applyExit(o, date, o.exit, 'factual');
        });
      });
      // scenario resolutions of unresolved orders whose timestamp maps to this record (an order issued on this very record, reachable only by the
      // clamp to the last record, is resolved after its step-7 admission below)
      var deferred = [];
      (resAt[ri] || []).forEach(function (x) { var o0 = byId[x.u.orderId]; if (o0.issueDate === date && !st.pend[o0.id] && !st.open[o0.id]) deferred.push(x); else applyResolution(x, date); });
      // step 4: marks, E, HWM, drawdown, risk flag
      var marked = 0;
      Object.keys(st.open).forEach(function (k) {
        var o = byId[k], mk = null; for (var i = o.marks.length - 1; i >= 0; i--) if (o.marks[i].date <= date) { mk = o.marks[i]; break; }
        marked += mk ? mk.valueCents : o.fill.notionalCents;
      });
      var E = st.cash + marked; st.hwm = st.hwm == null ? E : Math.max(st.hwm, E);
      var pendL = listOf(st.pend), openL = listOf(st.open), risk = 0;
      pendL.forEach(function (o) { risk += plannedRiskCents(o); }); openL.forEach(function (o) { risk += notional(o.Q, o.lotsInv, Math.max(0, o.fill.price - o.S)); });
      // step 5: the path's own suspension
      var newlySus = false;
      if (!st.suspended && st.hwm > 0 && (st.hwm - E) * CFG.DD_SUSPEND_DEN >= CFG.DD_SUSPEND_NUM * st.hwm) { st.suspended = true; out.suspendedAt = date; newlySus = true; }
      orders.forEach(function (o) {
        if (st.excl[o.id]) return;
        var f5 = evsAt(o, date, [5]);
        if (st.suspended) {
          if (f5.length) f5.forEach(function (e) { if (e.type === 'reservation-released') releaseRes(o.id); });
          else if (newlySus && st.pend[o.id]) exclude(o, 'scenario-suspension', date);
        } else if (f5.length) exclude(o, 'factual-cancelled-not-simulable', date);   // the factual path cancelled it; its unobserved outcome cannot be simulated
      });
      // step 7: factual issuance decisions, admitted only if admissible against this path's own state
      orders.forEach(function (o) {
        if (o.issueDate !== date || st.excl[o.id] || o.status === 'rejected-invalid-at-submission') return;   // a rejected submission never reaches the market
        var coinsHeld = {}; Object.keys(st.pend).concat(Object.keys(st.open)).forEach(function (k) { coinsHeld[byId[k].cgId] = 1; });
        var why = pathAdmission(listOf(st.pend), listOf(st.open), st.cash, resSum(), E, o, st.suspended, coinsHeld);
        if (why) { st.excl[o.id] = why; out.inadmissible.push({ orderId: o.id, reason: why, date: date }); return; }
        st.resv[o.id] = o.Ncents + o.feeReserveCents; st.pend[o.id] = 1;
        // submission-time events of this order (immediate ask fill): the reservation is released and the fill applied exactly as the factual book did, in event order
        o.events.forEach(function (e) { if (e.date === date && e.step === 7) { if (e.type === 'reservation-released') releaseRes(o.id); else if (e.type === 'filled') applyFill(o, date); } });
      });
      deferred.forEach(function (x) { applyResolution(x, date); });
      out.series.push({ date: date, cutoffSec: row.cutoffSec, cash: st.cash, reserved: resSum(), marked: marked, E: E, HWM: st.hwm, drawdown: st.hwm > 0 ? (st.hwm - E) / st.hwm : 0, suspended: st.suspended, riskLimitExceeded: risk * 10000 > E * CFG.RISK_LIMIT_BP });
    }
    // factual trades whose exit was adjudicated in the record dates are already in out.trades; scenario-inadmissible orders never appear
    return out;
  }
  // buildScenarios(book, ctx): ctx = { deadlineSec }. Returns the counterfactual namespace; `book` is not modified.
  function buildScenarios(book, ctx) {
    var res = { schemaVersion: 1, label: 'counterfactual', deadlineSec: ctx.deadlineSec, unresolved: {}, paths: { S1: {}, S2: {}, S1adv: {}, S2adv: {} } };
    (ctx.policies || ['N0', 'C1']).forEach(function (pid) {
      var un = unresolvedOf(book, pid, ctx); res.unresolved[pid] = un;
      res.paths.S1[pid] = replayPath(book, pid, 'S1', 'base', ctx, un);
      res.paths.S2[pid] = replayPath(book, pid, 'S2', 'base', ctx, un);
      res.paths.S1adv[pid] = replayPath(book, pid, 'S1', 'allAdverse', ctx, un);
      res.paths.S2adv[pid] = replayPath(book, pid, 'S2', 'allAdverse', ctx, un);
    });
    return res;
  }

  return {
    predicateHolds: predicateHolds, predicateDiagnosis: predicateDiagnosis, qualify: qualify, inZoneTol: inZoneTol, inZone: inZone, newShadowBook: newShadowBook, validateChallenger: validateChallenger, challengerActive: challengerActive,
    buildScenarios: buildScenarios, unresolvedOf: unresolvedOf, replayPath: replayPath, pathAdmission: pathAdmission, rowIndexAtOrAfter: rowIndexAtOrAfter,
    ORDERS_SCHEMA_VERSION: ORDERS_SCHEMA_VERSION, CFG: CFG, DAY: DAY, BAR5: BAR5, newBook: newBook, cents: cents, bpOf: bpOf, floorTo: floorTo, ceilTo: ceilTo, notional: notional,
    adjudicateAll: adjudicateAll, valuation: valuation, suspend: suspend, issueBatch: issueBatch,
    setInPlace: function (v) { inPlace = !!v; }, obligations: obligations, exposureCoins: exposureCoins, exitRules: exitRules, sideCharges: sideCharges, admittedRiskCents: admittedRiskCents, capacityOk: capacityOk,
    isPending: isPending, isOpen: isOpen, plannedRiskCents: plannedRiskCents, clone: clone, indexBars: indexBars, reservedSum: reservedSum, ordersOf: ordersOf
  };
});
