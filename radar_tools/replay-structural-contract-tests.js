/* radar_tools/replay-structural-contract-tests.js — Checkpoint 7b, Acceptance 7 (contract tests) for the
 * REPLAY DRIVER's own wiring of Protocol v1.4 §3 rule 1 (structural-continuity fallback). episodes-core.js's
 * own contract (structural fit can never open/screen/predicate/issue/consume) is already covered generically
 * by radar_tools/pending-review/episode-continuity-contract-tests.js (checkpoint 7a, 9/9, direct EC.updateEpisodes
 * calls) — this file instead proves the replay-driver's ACTUAL day-by-day wiring (sharedDayStep + simulateFamily)
 * respects that contract against real historical data, exactly as capture.js's own wiring does.
 * Run: node radar_tools/replay-structural-contract-tests.js
 *
 * Checkpoint 7c item 1: sharedDayStep/simulateFamily now gate coin evaluation on warmupCandles (default 153;
 * absent below it), where this file previously had no such gate at all (its only gate was always
 * MIN_CANDLES_FOR_FIT=30). This file's fixture window (Q4 2024, chosen for a known litecoin structural-only
 * run around 2024-11-08) predates every coin's 153-candle warm-up, so every call here passes an explicit
 * warmupCandles=30 to restore the exact pre-7c-item-1 behavior this file was written against - this file is
 * about episodes-core's structural-continuity wiring, not about the warm-up feature, so it deliberately does
 * not exercise the new default.
 */
'use strict';
const assert = require('assert');
const D = require('./replay/replay-driver.js');
const I = D.internal;

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message); console.log(e.stack); }
}

const universe = D.loadUniverse();

test('structural-only days occur in the real development window (sanity: not a vacuous suite)', function () {
  var prior = null, structDayCount = 0;
  I.dateRange('2024-10-01', '2024-12-31').forEach(function (d) {
    var shared = I.sharedDayStep(universe, d, prior, null, 30);
    prior = shared.nextEpisodesState;
    structDayCount += shared.episodeDayRows.filter(function (r) { return r.fitKind === 'structural'; }).length;
  });
  assert.ok(structDayCount > 0, 'expected at least one fitKind:structural row in Q4 2024 (found litecoin ep-litecoin-2024-11-08 in exploration)');
});

test('every fitKind:structural row carries a non-empty evidenceAnchors array and a geometry object (continuity evidence present)', function () {
  var prior = null, checked = 0;
  I.dateRange('2024-10-01', '2025-01-31').forEach(function (d) {
    var shared = I.sharedDayStep(universe, d, prior, null, 30);
    prior = shared.nextEpisodesState;
    shared.episodeDayRows.forEach(function (r) {
      if (r.fitKind !== 'structural') return;
      checked++;
      assert.ok(Array.isArray(r.evidenceAnchors) && r.evidenceAnchors.length > 0, 'structural row missing evidenceAnchors: ' + JSON.stringify(r));
      assert.ok(r.geometry && typeof r.geometry === 'object', 'structural row missing geometry: ' + JSON.stringify(r));
      assert.ok(r.fitId, 'structural row missing fitId (evidence fit id): ' + JSON.stringify(r));
    });
  });
  assert.ok(checked > 0, 'sanity: at least one structural row must have been checked');
});

test('every fitKind:policy row has evidenceAnchors === null (evidence id is structural-only, never on a policy fit)', function () {
  var prior = null, checked = 0;
  I.dateRange('2024-10-01', '2024-11-30').forEach(function (d) {
    var shared = I.sharedDayStep(universe, d, prior, null, 30);
    prior = shared.nextEpisodesState;
    shared.episodeDayRows.forEach(function (r) {
      if (r.fitKind !== 'policy') return;
      checked++;
      assert.strictEqual(r.evidenceAnchors, null, 'policy-fit row must not carry evidenceAnchors: ' + JSON.stringify(r));
    });
  });
  assert.ok(checked > 0, 'sanity: at least one policy row must have been checked');
});

test('a structural-only day never opens an episode: every "opening" episodeDay row traces to a real policy fit that day', function () {
  var prior = null, openings = 0;
  I.dateRange('2024-09-01', '2025-08-31').forEach(function (d) {
    var shared = I.sharedDayStep(universe, d, prior, null, 30);
    prior = shared.nextEpisodesState;
    var byEpisode = {}; shared.episodeDayRows.forEach(function (r) { byEpisode[r.episodeId] = r; });
    shared.episodeDays.forEach(function (ed) {
      if (!ed.opening) return;
      openings++;
      var row = byEpisode[ed.episodeId];
      assert.ok(row, 'opening episodeDay has no matching episodeDayRow: ' + JSON.stringify(ed));
      assert.strictEqual(row.fitKind, 'policy', 'an episode must never open on a structural-only day: ' + JSON.stringify(ed));
      assert.ok(ed.fitId, 'opening episodeDay must carry the policy fitId');
    });
  });
  assert.ok(openings > 0, 'sanity: at least one episode must have opened over the full development window');
});

test('a structural-only day never satisfies the screen, never becomes a candidate, and consumes no attempt: every candidate/episodeDay traces to fitKind:policy', function () {
  var prior = null, candidateDays = 0;
  I.dateRange('2024-09-01', '2025-03-31').forEach(function (d) {
    var shared = I.sharedDayStep(universe, d, prior, null, 30);
    prior = shared.nextEpisodesState;
    var byEpisode = {}; shared.episodeDayRows.forEach(function (r) { byEpisode[r.episodeId] = r; });
    shared.candidates.forEach(function (c) {
      candidateDays++;
      var row = byEpisode[c.episodeId];
      assert.ok(row, 'candidate has no matching episodeDayRow: ' + JSON.stringify(c));
      assert.strictEqual(row.fitKind, 'policy', 'a candidate (issuance-eligible episode-day) must always trace to a POLICY fit, never structural: ' + JSON.stringify(c));
    });
  });
  assert.ok(candidateDays > 0, 'sanity: at least one candidate must have been produced over the window');
});

test('end-to-end: running N0 through a structural-only-day episode never issues an attempt on that (episode, structural-day) pair', function () {
  var fam = I.buildPolicyFamily();
  var dates = I.dateRange('2024-11-01', '2024-11-30');   // covers ep-litecoin-2024-11-08's structural-only run (2024-11-09..11+)
  var structDates = {};
  var books = I.simulateFamily(universe, dates, [fam.n0], function () { return true; }, null, function (dateStr, shared) {
    shared.episodeDayRows.forEach(function (r) { if (r.fitKind === 'structural') { structDates[r.episodeId] = structDates[r.episodeId] || []; structDates[r.episodeId].push(dateStr); } });
  }, 30);
  var episodeIds = Object.keys(structDates);
  assert.ok(episodeIds.length > 0, 'sanity: expected at least one episode with structural-only days in Nov 2024');
  episodeIds.forEach(function (epId) {
    var structDays = structDates[epId];
    var attemptsOnStructDays = books.N0.attempts.filter(function (a) { return a.episodeId === epId && structDays.indexOf(a.date) >= 0; });
    assert.strictEqual(attemptsOnStructDays.length, 0, 'episode ' + epId + ' must consume no N0 attempt on its structural-only days ' + JSON.stringify(structDays) + ' but found ' + JSON.stringify(attemptsOnStructDays));
  });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
