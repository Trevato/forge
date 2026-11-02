# Visibility

What shows only on a wide screen, only when script runs, or only to an admin when the forge runs with reduced protection. Each rule
lives in `src/web/style/base.ts`.

- `.hide-sm` — hidden under the small breakpoint, shown (`inline-flex`) from it up; for labels and controls a narrow
  topbar or row has no room for. Written by `userMenu()`, `searchBar()` and `helpItem` in
  `src/web/layout.ts`, `fileHeader()` in `src/web/diff-view.ts` and `boardPage()` in `src/web/pages/board.ts`.
- `.js-only` — hidden until the shell script sets `:root.js`, then `inline-flex`; carried by every control that only
  works with a script, so a page without one never shows a dead button. Written by `helpItem` and `footer()` in
  `src/web/layout.ts`, `systemPage()` in `src/web/pages/system.ts`, `copyBtn()` in `src/web/pages/origins.ts`,
  `finderButton()` in `src/web/pages/explorer.ts` and `drawMap()` in `src/web/pages/map.ts`.
- `.reduced` — the footer's reduced-protection notice (`#reduced-protection`), shown only to an admin, from `protectionNotice()`,
  and muted by `.foot .reduced`. Written by `footer()` in `src/web/layout.ts`. It is not about
  `prefers-reduced-motion`.
