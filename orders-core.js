/* orders-core.js — Forward Experiment Protocol v1.2 §4–§6 (orders, execution, accounts, scenarios). Pure: no fs, no Date, no globals, no I/O.
 * setups-core.js (the B0 ledger) is untouched; B0 stays a continuity reference. Detection logic is untouched: S and T are taken exactly as logged
 * (Protocol §4.1: the ATR-capped stop may sit above the defended low; an independent resistance line is the target without a nearer-swing-high check).
 *
 * BOOK = { schemaVersion, orders[], attempts[], accounts: { N0: acct, C1: acct } }. All functions take a book and return a NEW book (deep clone).
 * Pipeline (Protocol §4.0), called by capture.js per canonical capture, in this order:
 *   2 adjudicateAll(book, capture, barsByCoin)        3 activateAll(book, capture, barsByCoin)
 *   4 valuation(book, policyId, capture, barsByCoin)  5 suspend(book, policyId, capture)
 *   7 issueBatch(book, policy, candidates, capture, cfg)
 * barsByCoin = { [cgId]: { candles: [{id,open,high,low,close}] } } — candles USABLE at the capture's issueTimeUtc, distinct ids (id = open time, unix s).
 * capture = { captureId, date, inputCutoffSec, issueTimeUtc }. All USD amounts are integer cents; prices are real numbers on the tick grid.
 * Order state is event-sourced: order.events is append-only, keyed (type|barId|k); re-applying an event is a no-op.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.OrdersCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var ORDERS_SCHEMA_VERSION = 1, DAY = 86400;
  // Constants (Protocol §0, §4, §5). Basis points are integers so every charge is computed exactly.
  var CFG = {
    START_CASH: 1500000,          // $15,000 (§5.2)
    BUDGET_BP: 150,               // 1R budget B = 1.5% of E_issue (§0), in basis points of 10,000
    RISK_LIMIT_BP: 450,           // admitted risk <= 3 x 1.5% x E_issue (§5.4)
    SLOTS: 3, EXPIRY_BARS: 3, HORIZON_BAR: 10, RETAIN_BARS: 20,
    DD_SUSPEND_NUM: 15, DD_SUSPEND_DEN: 100,   // drawdown >= 15% inclusive (§5.5)
    STALE_PERSISTENT_AT: 4,       // 4th consecutive capture without a usable mark (§0)
    MAKER_BP: 30, TAKER_BP: 60, FRICTION_BASE_BP: 10, FRICTION_ADVERSE_BP: 25,
    FEE_RESERVE_BP: 120           // feeReserve = 2 x 0.60% x (E_issue/3)
  };
  var PENDING = { issued: 1, resting: 1, 'pending-unresolved': 1, 'cancel-pending': 1 };
  var TERMINAL = { 'skipped-missing-input': 1, 'rejected-gap': 1, 'rejected-crossing': 1, expired: 1, 'cancelled-suspension': 1, exited: 1 };
  var TRANSITIONS = {
    issued: { 'skipped-missing-input': 1, 'rejected-gap': 1, resting: 1, 'cancelled-suspension': 1 },
    resting: { 'rejected-crossing': 1, 'pending-unresolved': 1, expired: 1, open: 1, 'cancelled-suspension': 1, 'cancel-pending': 1 },
    'pending-unresolved': { resting: 1, expired: 1, open: 1, 'cancel-pending': 1 },
    'cancel-pending': { 'cancelled-suspension': 1, open: 1, 'rejected-crossing': 1 },
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
    return { reason: r.reason, price: r.price, barId: bar.id, kind: r.kind, adverse: r.adverse, notionalCents: n, feeCents: ch.feeCents, frictionCents: ch.frictionCents,
      pnlCents: pnl, budgetR: o.Bcents ? pnl / o.Bcents : null, plannedRiskR: pnl / plannedRiskCents(o), captureId: capture.captureId, date: capture.date };
  }
  function plannedRiskCents(o) { return notional(o.Q, o.lotsInv, o.L - o.S) || 1; }

  // ---------- step 2: adjudication ----------
  function adjudicateOrder(book, o, byId, capture) {
    var a = book.accounts[o.policyId], guard = 0;
    var cutoff = capture.inputCutoffSec;
    while (guard++ < 64) {
      if (o.status === 'resting' || o.status === 'pending-unresolved' || o.status === 'cancel-pending') {
        if (o.status === 'cancel-pending' && o.nextBarId >= o.cancelCutoffSec) { terminate(book, o, capture, 'cancelled-suspension', 'cancel-pending resolved unfilled', 2); return; }
        var bar = byId[o.nextBarId];
        if (!bar) {   // never advance past an unusable bar: if the bar is due but not usable, the order waits (pending-unresolved), reservation and slot held
          if (o.nextBarId + DAY <= cutoff && o.status === 'resting') { setStatus(o, 'pending-unresolved'); addEv(o, capture, 'unresolved', { barId: o.nextBarId, step: 2 }); }
          return;
        }
        if (o.status === 'pending-unresolved') { setStatus(o, 'resting'); addEv(o, capture, 'resumed', { barId: o.nextBarId, step: 2 }); }
        var idx = o.eligibleDone + 1;
        o.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        if (idx === 1 && bar.open < o.L) { terminate(book, o, capture, 'rejected-crossing', 'submission-bar crossing', 2); return; }   // open = L rests
        var fillPrice = null, reason = null;
        if (idx >= 2 && bar.open < o.L) { fillPrice = bar.open; reason = 'fill-gap-open'; }
        else if (bar.low <= clean(o.L - o.tick)) { fillPrice = o.L; reason = 'limit'; }
        if (fillPrice != null) { doFill(book, o, bar, fillPrice, reason, capture); positionPhase(book, o, byId, capture); return; }
        o.eligibleDone++; o.nextBarId += DAY; addEv(o, capture, 'no-fill', { barId: bar.id, step: 2 });
        if (o.eligibleDone >= CFG.EXPIRY_BARS) { terminate(book, o, capture, o.status === 'cancel-pending' ? 'cancelled-suspension' : 'expired', 'eligible bars exhausted', 2); return; }
        continue;
      }
      if (o.fill) { positionPhase(book, o, byId, capture); }
      return;
    }
  }

  function doFill(book, o, bar, price, reason, capture) {
    var a = book.accounts[o.policyId], n = notional(o.Q, o.lotsInv, price);
    var ch = sideCharges(n, reason === 'fill-gap-open' ? 'taker' : 'maker', reason === 'fill-gap-open', 'base');
    o.fill = { price: price, barId: bar.id, reason: reason, notionalCents: n, feeCents: ch.feeCents, frictionCents: ch.frictionCents, adverse: reason === 'fill-gap-open', captureId: capture.captureId, date: capture.date };
    a.cash -= n + ch.feeCents + ch.frictionCents;
    releaseReservation(book, o, capture, 'filled');
    setStatus(o, 'open');
    o.hDone = 1; o.stale = { count: 0, persistent: false, mark: price, markDate: capture.date };
    addEv(o, capture, 'filled', { barId: bar.id, price: price, reason: reason, step: 2 });
    // fill-bar processing (§4.4): same bar, pessimistic
    var r = null;
    if (reason === 'fill-gap-open' && bar.open <= o.S) r = { reason: 'gap-stop-on-fill', price: bar.open, kind: 'taker', adverse: true };
    else if (bar.low <= o.S) r = { reason: 'ambiguous-stop', price: o.S, kind: 'taker', adverse: true };
    if (r) { primaryExit(book, o, r, bar, capture); o.sens.exit = exitRecord(o, r, bar, capture, 'base'); }
  }
  function primaryExit(book, o, r, bar, capture) {
    var a = book.accounts[o.policyId], rec = exitRecord(o, r, bar, capture, 'base');
    a.cash += rec.notionalCents - rec.feeCents - rec.frictionCents;
    o.exit = rec; setStatus(o, 'exited'); addEv(o, capture, 'exited', { barId: bar.id, reason: r.reason, price: r.price, step: 2 });
  }
  // Horizon bars 2..20 for filled orders, strictly sequential; the 20-bar sensitivity is its own state and never touches the account.
  function positionPhase(book, o, byId, capture) {
    var guard = 0;
    while (o.hDone < CFG.RETAIN_BARS && guard++ < 32) {
      var h = o.hDone + 1, id = o.fill.barId + (h - 1) * DAY, bar = byId[id];
      if (!bar) return;   // stall: no exit is adjudicated past an unusable bar
      o.bars.push({ id: bar.id, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      if (!o.exit) { var r = exitRules(bar, o, h === CFG.HORIZON_BAR); if (r) primaryExit(book, o, r, bar, capture); }
      if (!o.sens.exit) { var r2 = exitRules(bar, o, h === CFG.RETAIN_BARS); if (r2) o.sens.exit = exitRecord(o, r2, bar, capture, 'base'); }
      o.hDone = h;
    }
  }
  function adjudicateAll(book, capture, barsByCoin) {
    var b = cloneBook(book), idx = indexBars(barsByCoin); curStep = 2;
    b.orders.forEach(function (o) { if (o.status !== 'issued') adjudicateOrder(b, o, idx[o.cgId] || {}, capture); });
    curStep = null; return b;
  }

  // ---------- step 3: activation (§4.2) ----------
  function activateOrder(book, o, capture, dCandle) {
    if (o.status !== 'issued' || capture.inputCutoffSec < o.dId + DAY) return;   // not yet the D+1 evaluation
    if (capture.inputCutoffSec > o.dId + DAY) { terminate(book, o, capture, 'skipped-missing-input', 'no canonical capture on D+1', 3); return; }
    if (!dCandle) { terminate(book, o, capture, 'skipped-missing-input', 'D candle unusable at activation', 3); return; }
    if (dCandle.close < o.S) { terminate(book, o, capture, 'rejected-gap', 'D close below S', 3); return; }   // D close = S submits
    setStatus(o, 'resting'); o.nextBarId = o.dId + DAY; o.submittedAtSec = o.dId + DAY; addEv(o, capture, 'status', { to: 'resting', step: 3, k: 'resting' });
  }
  function activateAll(book, capture, barsByCoin) {
    var b = cloneBook(book), idx = indexBars(barsByCoin); curStep = 3;
    b.orders.forEach(function (o) { if (o.status === 'issued') activateOrder(b, o, capture, (idx[o.cgId] || {})[o.dId] || null); });
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
    var b = cloneBook(book), a = b.accounts[pid], idx = indexBars(barsByCoin), marked = 0, anyStale = false;
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
    return b;
  }

  // ---------- step 5: suspension (§5.5) ----------
  function suspend(book, pid, capture) {
    var b = cloneBook(book), a = b.accounts[pid], v = a.lastValuation; curStep = 5;
    if (!v || v.captureId !== capture.captureId) { curStep = null; throw new Error('valuation() must run before suspend()'); }
    if (!a.suspended && v.HWM > 0 && (v.HWM - v.E) * CFG.DD_SUSPEND_DEN >= CFG.DD_SUSPEND_NUM * v.HWM) {
      a.suspended = true; a.suspendedAt = capture.date; a.suspensionCutoffSec = capture.inputCutoffSec;
      var last = a.series[a.series.length - 1]; if (last && last.captureId === capture.captureId) last.suspended = true;
      var cut = capture.inputCutoffSec;
      ordersOf(b, pid).forEach(function (o) {
        if (o.status === 'issued') { terminate(b, o, capture, 'cancelled-suspension', 'suspension', 5); return; }
        if (o.status === 'resting') {
          // every eligible bar opening before the cutoff must already be adjudicated (usable) and unfilled
          var pre = firstPreCutoffUnadjudicated(o, cut);
          if (pre == null) terminate(b, o, capture, 'cancelled-suspension', 'suspension', 5);
          else { setStatus(o, 'cancel-pending'); o.cancelCutoffSec = cut; addEv(o, capture, 'cancel-pending', { cutoff: cut, step: 5 }); }
          return;
        }
        if (o.status === 'pending-unresolved') { setStatus(o, 'cancel-pending'); o.cancelCutoffSec = cut; addEv(o, capture, 'cancel-pending', { cutoff: cut, step: 5 }); }
      });
    }
    curStep = null; return b;
  }
  function firstPreCutoffUnadjudicated(o, cut) { for (var k = o.eligibleDone + 1; k <= CFG.EXPIRY_BARS; k++) { var id = o.dId + k * DAY; if (id < cut) return id; } return null; }

  // ---------- step 7: issuance (§4.1, §5.3, §5.4) ----------
  function inZone(cand) { var ez = cand.entryEconomics && cand.entryEconomics.entryZone; return !!(ez && num(ez[0]) && num(ez[1]) && num(cand.price) && cand.price >= ez[0] && cand.price <= ez[1]); }
  function predicateHolds(policy, cand, cfg) {
    if (!(cand.screen && cand.screen.pass) || !inZone(cand)) return false;
    if (policy.id === 'N0') return true;
    var ch = cfg && cfg.challenger; if (!ch) return false;   // C1 not configured: never qualifies
    if (num(ch.minScore) && !(num(cand.score) && cand.score >= ch.minScore)) return false;
    if (num(ch.minNetRR) && !(cand.entryEconomics && num(cand.entryEconomics.netRR) && cand.entryEconomics.netRR >= ch.minNetRR)) return false;
    return true;
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
    for (var i = 0; i < b.attempts.length; i++) if (b.attempts[i].policyId === pid && b.attempts[i].episodeId === cand.episodeId) return;   // one attempt per (policy, episode)
    if (!predicateHolds(policy, cand, cfg)) return;                                   // no consumption
    if (cand.venueEligible === false || !metaOk(cand.meta)) { results.push({ episodeId: cand.episodeId, outcome: cand.venueEligible === false ? 'ineligible-venue' : 'ineligible-metadata', consumed: false }); return; }
    var ee = cand.entryEconomics;
    if (ee.stopBasis == null || ee.targetSource == null) throw new Error('log row lacks stopBasis/targetSource for ' + cand.cgId);
    var attempt = { policyId: pid, policyVersion: policy.version, episodeId: cand.episodeId, cgId: cand.cgId, captureId: capture.captureId, date: capture.date, outcome: null, orderId: null };
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
    b.seq++;
    var o = { id: pid + '-' + capture.date + '-' + cand.cgId, seq: b.seq, policyId: pid, policyVersion: policy.version, episodeId: cand.episodeId, cgId: cand.cgId, pair: cand.pair || null,
      captureId: capture.captureId, issueDate: capture.date, issueTimeUtc: capture.issueTimeUtc || null, dId: capture.inputCutoffSec,
      L: L, S: S, T: T, tick: tick, lot: lot, lotsInv: lotsInv, minOrder: minOrder, Bcents: Bc, Eissue: Eissue, Q: qLots, qty: qLots / lotsInv, Ncents: N, feeReserveCents: feeReserve, sizeClipped: sizeClipped,
      stopBasis: ee.stopBasis, targetSource: ee.targetSource, score: num(cand.score) ? cand.score : null,
      charges: { makerBp: CFG.MAKER_BP, takerBp: CFG.TAKER_BP, frictionBaseBp: CFG.FRICTION_BASE_BP, frictionAdverseBp: CFG.FRICTION_ADVERSE_BP }, expiryBar: CFG.EXPIRY_BARS,
      status: 'issued', events: [], bars: [], eligibleDone: 0, nextBarId: null, hDone: 0, fill: null, exit: null, sens: { exit: null }, marks: [], stale: null, cancelCutoffSec: null };
    a.reservations.push({ orderId: o.id, cents: res });
    addEv(o, capture, 'issued', { step: 7 }); addEv(o, capture, 'reservation-made', { cents: res, step: 7 });
    b.orders.push(o); attempt.outcome = 'order'; attempt.orderId = o.id;
    results.push({ episodeId: cand.episodeId, outcome: 'order', consumed: true, orderId: o.id });
  }
  // candidates: [{ episodeId, cgId, pair, screen:{pass}, price, score, entryEconomics:{entryZone,stop,target,stopBasis,targetSource,netRR}, venueEligible, meta:{tick,lot,minOrder} }]
  function issueBatch(book, policy, candidates, capture, cfg) {
    var b = cloneBook(book), a = b.accounts[policy.id], results = [];
    if (!a.lastValuation || a.lastValuation.captureId !== capture.captureId) throw new Error('valuation() must run at step 4 of this capture before issueBatch()');
    var blocked = a.suspended ? 'suspended' : (staleBlocked(b, policy.id) ? 'skipped-stale-mark' : null);
    var row = a.series[a.series.length - 1]; if (row && row.captureId === capture.captureId) row.blockedReason = blocked;
    if (blocked) return { book: b, results: [], blockedReason: blocked };
    var list = (candidates || []).slice().sort(function (x, y) { var sx = num(x.score) ? x.score : -Infinity, sy = num(y.score) ? y.score : -Infinity; return sy - sx || (x.cgId < y.cgId ? -1 : x.cgId > y.cgId ? 1 : 0); });
    list.forEach(function (c) { issueOne(b, policy, c, capture, cfg || {}, results); });
    return { book: b, results: results, blockedReason: null };
  }

  // ---------- obligations (§3) ----------
  function obligations(book) {
    var out = [];
    book.orders.forEach(function (o) {
      var rem = 0;
      if (o.status === 'issued') rem = CFG.EXPIRY_BARS;
      else if (o.status === 'resting' || o.status === 'pending-unresolved') rem = CFG.EXPIRY_BARS - o.eligibleDone;
      else if (o.status === 'cancel-pending') { rem = 0; for (var k = o.eligibleDone + 1; k <= CFG.EXPIRY_BARS; k++) if (o.dId + k * DAY < o.cancelCutoffSec) rem++; }
      else if (o.fill) rem = CFG.RETAIN_BARS - o.hDone;
      if (rem > 0) out.push({ orderId: o.id, episodeId: o.episodeId, cgId: o.cgId, policyId: o.policyId, remainingBars: rem });
    });
    return out;
  }
  function exposureCoins(book) { var s = {}; book.orders.forEach(function (o) { if (isPending(o) || isOpen(o)) s[o.cgId] = 1; }); return Object.keys(s).sort(); }

  // ---------- §6 scenarios (counterfactual namespace; the factual book is never modified) ----------
  // Unresolved at the deadline: still `issued`, pending-unresolved / cancel-pending, or open with the bars needed for an exit not usable.
  // Factual resolution from bars usable by the deadline (S3) is applied first by the caller (adjudicateAll on the lock dataset).
  function barOf(o, id) { for (var i = 0; i < o.bars.length; i++) if (o.bars[i].id === id) return o.bars[i]; return null; }
  function classifyUnresolved(o, ctx) {
    if (o.status === 'issued') return { row: 1, kind: 'issued' };
    if (o.status === 'pending-unresolved' || o.status === 'cancel-pending') return { row: 2, kind: o.status, missingBarId: o.nextBarId };
    if (o.status === 'open') {
      var nb = o.fill.barId + o.hDone * DAY;
      if (nb + DAY <= ctx.deadlineSec) return { row: 3, kind: 'open-exit-unresolved', missingBarId: nb, lastUsableId: nb - DAY };
      return { row: 4, kind: 'open-horizon-not-reached', lastUsableId: nb - DAY };
    }
    return null;
  }
  // Resolution of one unresolved order under scenario S ('S1' stress | 'S2' primary): { kind, tsSec, exit? , entry? }
  function resolveOrder(o, cls, S, ctx) {
    var dl = ctx.deadlineSec;
    if (cls.row === 1) return { kind: 'skipped-missing-input', tsSec: dl };
    if (cls.row === 2) {
      if (S === 'S1') return { kind: 'filled-stopped', tsSec: cls.missingBarId + DAY, entryPrice: o.L, exitPrice: o.S, barId: cls.missingBarId };
      return { kind: o.status === 'cancel-pending' ? 'cancelled-suspension' : 'expired', tsSec: dl };
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
    function entryCharges(o) { var f = o.fill; return sideCharges(f.notionalCents, f.reason === 'fill-gap-open' ? 'taker' : 'maker', f.adverse, mode); }
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
      // steps 2 and 3: factual adjudication events in order-seq order
      orders.forEach(function (o) {
        if (st.excl[o.id]) return;
        evsAt(o, date, [2, 3]).forEach(function (e) {
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
        if (o.issueDate !== date || st.excl[o.id]) return;
        var coinsHeld = {}; Object.keys(st.pend).concat(Object.keys(st.open)).forEach(function (k) { coinsHeld[byId[k].cgId] = 1; });
        var why = pathAdmission(listOf(st.pend), listOf(st.open), st.cash, resSum(), E, o, st.suspended, coinsHeld);
        if (why) { st.excl[o.id] = why; out.inadmissible.push({ orderId: o.id, reason: why, date: date }); return; }
        st.resv[o.id] = o.Ncents + o.feeReserveCents; st.pend[o.id] = 1;
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
    ['N0', 'C1'].forEach(function (pid) {
      var un = unresolvedOf(book, pid, ctx); res.unresolved[pid] = un;
      res.paths.S1[pid] = replayPath(book, pid, 'S1', 'base', ctx, un);
      res.paths.S2[pid] = replayPath(book, pid, 'S2', 'base', ctx, un);
      res.paths.S1adv[pid] = replayPath(book, pid, 'S1', 'allAdverse', ctx, un);
      res.paths.S2adv[pid] = replayPath(book, pid, 'S2', 'allAdverse', ctx, un);
    });
    return res;
  }

  return {
    buildScenarios: buildScenarios, unresolvedOf: unresolvedOf, replayPath: replayPath, pathAdmission: pathAdmission, rowIndexAtOrAfter: rowIndexAtOrAfter,
    ORDERS_SCHEMA_VERSION: ORDERS_SCHEMA_VERSION, CFG: CFG, DAY: DAY, newBook: newBook, cents: cents, bpOf: bpOf, floorTo: floorTo, ceilTo: ceilTo, notional: notional,
    adjudicateAll: adjudicateAll, activateAll: activateAll, activateOrder: activateOrder, valuation: valuation, suspend: suspend, issueBatch: issueBatch,
    setInPlace: function (v) { inPlace = !!v; }, obligations: obligations, exposureCoins: exposureCoins, exitRules: exitRules, sideCharges: sideCharges, admittedRiskCents: admittedRiskCents, capacityOk: capacityOk,
    isPending: isPending, isOpen: isOpen, plannedRiskCents: plannedRiskCents, clone: clone, indexBars: indexBars, reservedSum: reservedSum, ordersOf: ordersOf
  };
});
