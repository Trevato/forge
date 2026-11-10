# Chart

- Series colours — the eight colours the fleet graph's stacked bar chart draws its series in, one class per series index, drawn by `windowSvg()` in `src/web/fleet-graph.ts` on each bar's `<rect>` beside `data-series` (the same index `seriesDot()` keys the legend and table dots by). Each sets `fill` and `color` from its `--series-N` token in `src/design/themes.ts`: the Okabe–Ito palette, told apart with the common colour-vision deficiencies, with the folded "others" series grey.
  - `.fg-s0` — series 0.
  - `.fg-s1` — series 1.
  - `.fg-s2` — series 2.
  - `.fg-s3` — series 3.
  - `.fg-s4` — series 4.
  - `.fg-s5` — series 5.
  - `.fg-s6` — series 6.
  - `.fg-s7` — series 7, the folded "others" series (grey).

## The money line (#510)

Drawn by `src/web/studio/money_line.ts`; styled in `src/web/style/content.ts`.

- `.money-line` — the board's line: this month's cost, revenue and gap on one row, today's gap and the economics slider (the one link, in the accent) on a second, and the chart beside them. Two 24px rows are reserved, three at 480px and under where the first wraps once; the chart is a fixed size, zeros included, so nothing shifts.
- `.money-gap` — the gap, signed with + or −, in the text colour; `data-sign="down"` (a loss) alone takes `--attn`. The accent is never a gap's: it is for the link. The app page's month card wears it too.
- `.money-chart` — the thirty-day SVG, 240 × 48, server-rendered, no library. `.money-cost` (muted) and `.money-revenue` (text colour) are its two polylines; `.money-band` holds one polygon per pair of days, `data-sign` tinting the gap between them: a faint text-colour wash for a profit, `--attn` for a loss.
