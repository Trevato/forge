# Attention budgets

`docs/DESIGN.md` holds the five rules of attention. This is how they are measured.

`bun test test/attention.test.ts` renders each main page (signed in, on a small seeded forge) and counts what a
reader sees on first view at 390 px and 1280 px: **words**, **text blocks** and **distinct colours**
(`src/measure/attention.ts`). It prints each page's numbers against its budget in
`docs/design/attention-budget.json`, and fails when any number is over.

- A pass that makes a page quieter lowers its budget: `FORGE_ATTENTION_WRITE=1 bun test test/attention.test.ts`
  rewrites the file from today's numbers. Lowering is free.
- Raising a number needs a note in the pull saying why. Nothing else may.
- It counts the served HTML, with no browser: `hidden`, `.sr-only`, `.js-only`, the body of a closed `<details>`,
  and the classes the stylesheet hides at that width (`.hide-sm`, `.hide-lg`, `.keyhint`, `.crumbs`) are not seen.
  Layout is not simulated, so the whole visible `<main>` counts as first view, and today the two widths agree.
  A colour is a tone (`data-variant`, `data-tone`, `data-state`, `data-status`) other than the neutral ones, or a colour written in a `style`.
- On a live app: `bun scripts/measure-page.ts --attention /path …` prints one JSON line per page, `{path, status, firstView: {390: {words, blocks, colours}, 1280: …}}`, from a seeded forge it boots itself.
- `/:owner/:name/app` redirects to the repository page, so "a repository" and "an app" are one page today.

## Baseline (words / blocks / colours)

| Page | 390 px | 1280 px |
|---|---|---|
| home | 95 / 20 / 2 | 95 / 20 / 2 |
| repository | 116 / 18 / 2 | 116 / 18 / 2 |
| app | 116 / 18 / 2 | 116 / 18 / 2 |
| pull | 141 / 24 / 4 | 141 / 24 / 4 |
| issue | 72 / 19 / 2 | 72 / 19 / 2 |
| issues list | 30 / 7 / 2 | 30 / 7 / 2 |
| pulls list | 24 / 6 / 1 | 24 / 6 / 1 |
| runs | 38 / 8 / 1 | 38 / 8 / 1 |
| run | 34 / 11 / 3 | 34 / 11 / 3 |
| settings | 140 / 32 / 1 | 140 / 32 / 1 |
| search | 42 / 3 / 1 | 42 / 3 / 1 |
| search results (`/search?q=forge`) | 58 / 5 / 1 | 58 / 5 / 1 |
| map | 68 / 6 / 6 | 68 / 6 / 6 |
| flow | 102 / 9 / 1 | 102 / 9 / 1 |
| system | 212 / 65 / 0 | 212 / 65 / 0 |

`/flow` and `/system` are sampled pages; their entries are the empty state the test forge has (nothing seeded, nothing waited for), and say so in the entry's `note`. `/system` draws the host it runs on, so the test hands it an empty machine reading (`useLive`) and fixed cap sentences; a live `/system` is larger.

## App page, calmed (#10299)

A new app that has not run, and has shipped nothing, shows only its progress: the state line (`docs/features/onboarding-line.md`), the box to tell the crew, and Now (`src/web/studio/fresh.ts` judges it). Past that, the empty This week and Crew cards are gone, and the page's second link row (Map, Issues, Pull requests) is gone because the head's tabs already hold them. Before, on the seeded new app: 197 words / 29 blocks (over its 189 / 28 budget on main); after: 116 / 18.
