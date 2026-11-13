# Chart

## The one chart (`src/boards/chart.ts`)

Every chart on a board, on Explore the data and on /system is drawn one way. The plot is an SVG that stretches to its box and whose strokes do not scale; every word around it is the page's own text at the type floor (`--fs-min`), tabular, so a label is never scaled, clipped or wrapped at any width. The plot's height is `--chart-h` (168px), the same for every chart, and a taller panel (`.bp-h2`, `.bp-h3`) sets it. One series is the accent; several are the series tokens below (`.fg-s0`…) with a legend. Times are said as words ("Nov 13", "16:40"), numbers as a person reads them (1,234 · 12.3k · 7.1G). A point says its value on hover and on focus, and is a link when it has rows behind it; a sentence only a screen reader hears says the range, the lowest, the highest and the latest. Styled in `src/web/style/content.ts`.

- `.chart-box` — the frame `chartBox()` writes (`.is-table` for a table panel); it is the container a narrow chart measures itself against.
- `.chart` — the grid: the y values, the plot, the labels under it, the legend. `data-chart` names the kind.
- `.chart-y` — the three values of the y axis (top, middle, zero), centred on the gridlines; `.is-rows` for a heat strip's row names.
- `.chart-plot` — the stretched SVG. `.chart-grid` its three hairlines, `.chart-line` a series' line (`.spark` under a number), `.chart-wash` the faint fill under one line, `.bar` a bar, `.area` a stacked band, `.cell` a heat cell.
- `.chart-hit` — a point's full-height hover column: it says the value (`<title>`), washes on hover and on its link's focus, and is the link to the rows behind the point.
- `.chart-x` — at most five labels under the plot, placed at their points (`.is-one` for a single point, `.is-slots` when a few bars each get their own place); under 440px of chart it keeps the first, the middle and the last.
- `.chart-key` — the legend: a swatch and a name per series, ellipsised, never wrapped inside a name.
- `.chart-big`, `.big` — a number panel's value and the sentence beside it.
- `.chart-none` — "No points in this range.", holding the chart's height.

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

- `.money-line` — the board's line: this month's cost, revenue, gap and the slider's word (`spend: balanced`) on one row, today's gap on a second, and the chart beside them. Two 24px rows are reserved, three at 480px and under where the first wraps once; the chart is a fixed size, zeros included, so nothing shifts.
- `.money-gap` — the gap, signed with + or −, in the text colour; `data-sign="down"` (a loss) alone takes `--attn`. The accent is never a gap's: it is for the link. The app page's month card wears it too.
- `.money-spend` — the slider's position in words (#11102), the line's one link to Settings → Economics, in the accent; it never breaks inside itself, so the row wraps between its parts.
- `.money-chart` — the thirty-day SVG, 240 × 48, server-rendered, no library. `.money-cost` (muted) and `.money-revenue` (text colour) are its two polylines; `.money-band` holds one polygon per pair of days, `data-sign` tinting the gap between them: a faint text-colour wash for a profit, `--attn` for a loss.
