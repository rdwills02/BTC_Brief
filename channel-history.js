/* channel-history.js — detect ALL historical channels for a coin's series.
 *
 * channel-core's detectChannel(candles) always detects the channel ENDING at the last candle
 * (lastIdx = n-1). To find every channel a coin formed over its history, we run detection on
 * progressively longer slices — candles[0..i] for i stepping across the series — and each run
 * returns the channel "as it stood" at candle i. We then collapse the stream of per-step
 * detections into DISTINCT channels (same channel persists across many steps as it extends;
 * a new firstIdx / a gap marks a new channel).
 *
 * Output: one record per distinct historical channel, each with a unique id + full profile,
 * ready to store as JSON and surface in radar / the overlay tool.
 *
 * Pure logic on top of channel-core — no fetch, no DOM. Node + browser compatible.
 */

(function(root){
  var C = (typeof require !== 'undefined') ? require('./channel-core.js') : root;

  // Minimum candles before detection can find a channel (needs pivots + touches).
  var MIN_HISTORY = 20;

  // Two detections belong to the SAME channel if their formation start (firstIdx) is within
  // this tolerance — as a channel extends step to step, firstIdx stays ~fixed. A jump in
  // firstIdx (or detection dropping to null then reappearing) starts a NEW channel.
  var SAME_CHANNEL_FIRSTIDX_TOL = 2;

  function detectAllChannels(candles, coinMeta) {
    coinMeta = coinMeta || {};
    var n = candles.length;
    if (n < MIN_HISTORY) return [];

    // Walk the history; detectChannel returns the best channel ending at each step (or null).
    // A channel's life = a run of detections sharing ~the same formation start (firstIdx). A
    // BRIEF null (or a momentary refit) does NOT end it — only a SUSTAINED break does, or a
    // genuinely new formation start that persists. This avoids splitting one real channel into
    // many records when detection flickers.
    var BREAK_GAP = 3;          // consecutive nulls required to declare a channel truly broken
    var runs = [];
    var current = null;
    var nullStreak = 0;

    for (var i = MIN_HISTORY - 1; i < n; i++) {
      var ch = C.detectChannel(candles.slice(0, i + 1));

      if (!ch) {
        nullStreak++;
        if (current && nullStreak >= BREAK_GAP) { runs.push(current); current = null; }
        continue;
      }
      nullStreak = 0;

      if (!current) {
        current = { startStep: i, endStep: i, best: ch, openFirstIdx: ch.firstIdx };
      } else if (Math.abs(ch.firstIdx - current.openFirstIdx) <= SAME_CHANNEL_FIRSTIDX_TOL) {
        // same formation start -> same channel, just longer. Keep peak detection, extend end.
        current.endStep = i;
        if (ch.score > current.best.score) current.best = ch;
      } else {
        // a different formation start that appeared without a sustained break -> new channel
        runs.push(current);
        current = { startStep: i, endStep: i, best: ch, openFirstIdx: ch.firstIdx };
      }
    }
    if (current) { runs.push(current); current = null; }

    // Merge any runs that ended up sharing a formation start (defensive dedupe).
    runs.sort(function(a,b){ return a.openFirstIdx - b.openFirstIdx || a.startStep - b.startStep; });
    var merged = [];
    runs.forEach(function(r){
      var last = merged[merged.length-1];
      if (last && Math.abs(r.openFirstIdx - last.openFirstIdx) <= SAME_CHANNEL_FIRSTIDX_TOL) {
        last.endStep = Math.max(last.endStep, r.endStep);
        if (r.best.score > last.best.score) last.best = r.best;
      } else {
        merged.push(r);
      }
    });
    runs = merged;

    // Build a clean record per distinct channel.
    return runs.map(function(run, k) {
      var d = run.best;                          // peak-score detection = representative profile
      var startIdx = run.openFirstIdx;         // firstIdx when the channel first appeared
      var endIdx = run.endStep;                  // last candle the channel was still live
      var startC = candles[startIdx] || {};
      var endC = candles[endIdx] || {};
      var startPrice = startC.close != null ? startC.close : null;
      var endPrice = endC.close != null ? endC.close : null;
      var runPct = (startPrice && endPrice) ? ((endPrice - startPrice) / startPrice) * 100 : null;

      return {
        id: (coinMeta.symbol || 'COIN') + '-CH' + (k + 1),
        symbol: coinMeta.symbol || null,
        cgId: coinMeta.cgId || null,
        startIdx: startIdx, endIdx: endIdx,
        startDate: startC.date || null, endDate: endC.date || null,
        durationCandles: endIdx - startIdx + 1,
        peakScore: d.score, finalScore: run.best.score,
        supSlope: d.supSlope, supIntercept: d.supIntercept, channelH: d.channelH,
        slope: d.slope, containment: d.containment,
        supportTouches: d.supportTouches, resTouches: d.resTouches,
        supportNow: d.supportNow, resistNow: d.resistNow, invalidation: d.invalidation,
        isAscending: d.isAscending, isFlat: d.isFlat, position: d.position,
        startPrice: startPrice, endPrice: endPrice, runPct: runPct,
        candles: candles.slice(startIdx, endIdx + 1)
      };
    });
  }

  var api = { detectAllChannels: detectAllChannels, MIN_HISTORY: MIN_HISTORY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.detectAllChannels = detectAllChannels; }
})(typeof self !== 'undefined' ? self : this);
