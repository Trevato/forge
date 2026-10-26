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
