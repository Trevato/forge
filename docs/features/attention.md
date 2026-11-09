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
| home | 182 / 20 / 3 | 182 / 20 / 3 |
| repository | 189 / 28 / 2 | 189 / 28 / 2 |
| app | 189 / 28 / 2 | 189 / 28 / 2 |
| pull | 133 / 22 / 4 | 133 / 22 / 4 |
| issue | 76 / 19 / 2 | 76 / 19 / 2 |
| issues list | 32 / 8 / 2 | 32 / 8 / 2 |
| pulls list | 31 / 7 / 1 | 31 / 7 / 1 |
| runs | 46 / 8 / 1 | 46 / 8 / 1 |
| run | 34 / 11 / 3 | 34 / 11 / 3 |
| settings | 274 / 37 / 1 | 274 / 37 / 1 |
