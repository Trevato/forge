# Design audit — 2026-10-19 (#2678): a source-drift report

The owner's words: "a giant pile of interfaces with no apparent reason". This
audit says what is true, what it rests on, and what it does not yet cover.

## What this audit is not

It is a report on drift in the source, **not** a judgement of how the pages
look. It has **no screenshots**, so it says nothing about layout shift, 360px,
contrast or dark mode; the verdicts in Finding 2 are about purpose and overlap
read from code, and are provisional until the sweep (#2690) lands. The agent that wrote it runs in a sandbox that cannot
open a browser or reach a running forge, so the desktop/360px × light/dark sweep
is not here; it is the first item of the plan (#2690) for a run that can. Everything else is read from the source: `src/web/**`, `docs/DESIGN.md`,
and the counts from `bun scripts/design-lint.ts`.

## Finding 1 — the design system exists; the pages left it

`docs/DESIGN.md` already is "one design system": tokens (palettes as data in
`src/design/themes.ts`), a type scale (11.5 / 12.5 / 13 / 14 / 15 / 16 / 20px),
a 4px grid, three radii, one accent, ~70 named components. The clean app
template's advantage is not a better system; it is that it never grew past it.

The forge's own source has drifted, measured today:

| drift                                            | count | where most                                                              |
| ------------------------------------------------ | ----: | ----------------------------------------------------------------------- |
| hex / `rgb()` / `hsl()` literals outside themes  |    95 | `style/content.ts` (23), `studio/home.ts` (7), `pages/looks.ts` (6), `pages/site.ts` (3) |
| `font-size` off the scale (13.5, 12, 11, 10, 22, 18, 72 …) |  67 | `style/content.ts` (31), `style/components.ts` (16), `pages/map.ts` (12), `pages/board.ts` (6) |
| classes defined in stylesheets                   |   619 | DESIGN.md §5 names ~70 components; the rest are page-local              |

619 classes against ~70 documented components is the "pile": most pages grew
their own vocabulary instead of composing the named one.

## Finding 2 — the pages, and what each is for

Judged by the question "what would the owner do here that they cannot do
elsewhere?". Page sizes are source lines, a rough proxy for how much each
invented.

| page               | for                                             | verdict                                                             |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------- |
| `/` (studio home)  | where I am, what needs me                       | keep; redo as KPIs the owner pins, not a to-do list (#2665)         |
| `/boards`          | saved queries as panels                         | keep; selectors unusable (#2666); becomes the home's panel source   |
| `/system`          | realtime machine state (btop)                   | keep; redo on the system (#2678 plan item 4)                        |
| `/flow`            | pipeline and bottleneck (topbar button, admin)  | overlaps `/system` and boards: merge as a board panel set           |
| `/settings/usage`, `/settings/capacity`, `/settings/telemetry`, spend | four pages about "how much is being used" | one page, tabs by `tabs()` — usage and spend are the same question |
| `/settings/model`, `/settings/cloud`, `/settings/backups`, `/settings/resilience` | machine/provider/recovery configuration | keep as settings sections; resilience (51 lines) folds into backups |
| `/map`             | 1,806 lines, 12 off-scale sizes, own colours    | the largest private vocabulary; review what it shows that `/boards` and the issue dependency list do not |
| `/audit`, `waves`, `variants`, `looks`, `returns`, `chain` | operator views of the crew's work | each needs a stated reason to be a page rather than a board panel |
| `/settings/*` rest | account, keys, tokens, origins, crew            | fine as one settings shell (`settingsLayout()`); no change          |

Duplication to resolve: three places answer "what is the forge doing right now"
(home, `/flow`, `/system`); four answer "what does it cost / how full is it".

## Finding 3 — what the clean app template does better

- One page, one purpose, one primary action. The forge's top bar carries
  Flow, search, help, theme, New, user — six controls before the page begins.
- It has no page-local CSS. Every forge page file that carries colour or size
  literals (list above) is a page that reinvented a token.
- First paint is the product. Several forge pages are tables of everything;
  the template shows three numbers and a list.

## Not covered

Screenshots, contrast measurement per palette, the TUI surface, and pages
behind a specific repo (`/:owner/:name/*`), which the repo header and tabs
already unify and which are not where the drift is.

## Plan

`docs/design/plan.md` — small issues, in order. The check that holds the line
meanwhile is `scripts/design-lint.ts` (run by `test/design-lint.test.ts`, so it
runs in the gate).
