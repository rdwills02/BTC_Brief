# Third-party notices (item 52p)

## Order Block Detector [LuxAlgo] — basis of `supply-zones-core.js`

- Work: "Order Block Detector [LuxAlgo]", TradingView open-source script, Pine v5, by LuxAlgo, last updated Mar 10, 2023.
- Source page: https://www.tradingview.com/script/KvGhxGxY-Order-Block-Detector-LuxAlgo/
- Licence of the original: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0), https://creativecommons.org/licenses/by-nc-sa/4.0/
- Snapshot of the source text (kept in this repository): [`third-party/order-block-detector-luxalgo.pine.txt`](third-party/order-block-detector-luxalgo.pine.txt) - the script as displayed on the page above, fetched in-page 2026-10-15 (page still reads "Updated Mar 10, 2023"), 233 lines, 7017 bytes, gutter line numbers absent, non-breaking spaces replaced by spaces, trailing whitespace trimmed, LF line ends, one final newline. Its first line is the upstream licence line. SHA-256 of the stored file: `e095c9513be0936a19919866abfb1b8e10b51539105169533b9e601669363a10`.
- Earlier pin: the 2026-10-14 port recorded `9563ced646fa13fed127c3e1f37a63e492251dd3ae64e13b4284d6c9792314dc` (also stated in the module header and `DETECTOR.sourceSha256`). The 2026-10-15 fetch does NOT reproduce it: about 900 combinations of start/end line, whitespace normalisation, line ending and final newline were tried, and none gives `9563ced6...`. The 2026-10-14 extraction method was not recorded, so whether upstream changed or only the extraction differed cannot be settled from here. The fetched text matches the logic the port implements (`phv = ta.pivothigh(volume, length, length)`; `os := high[length] > upper ? 0 : low[length] < lower ? 1 : os[1]`; bearish `phv and os == 0`, bullish `phv and os == 1`; Wick/Close mitigation). `DETECTOR.sourceSha256` is left unchanged so that replay records written before this date keep their detector identity; the stored file's hash above is the one to verify against.

### Modifications (this is an adapted derivative, not the original)
`supply-zones-core.js` is a JavaScript port of the bearish (52j) and bullish (52n) block logic. Differences from the script, as listed in the module header: zones are drawn from the confirmation time (not the origin candle); the display limit is the page's own selection rule; mitigation removes every affected zone on the candle; equal volumes yield no pivot (strict ties); only closed candles are used; a pivot window with missing volume is reported as `unevaluable` rather than skipped (52p); missing volume is never zero-filled.

### Licence of this derivative
This derivative port (`radar_tools/zones/supply-zones-core.js` and its test) is shared under the same licence, CC BY-NC-SA 4.0, for non-commercial use, with attribution to LuxAlgo as above. No endorsement by LuxAlgo or TradingView is implied.
