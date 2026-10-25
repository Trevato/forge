# DESIGN.md — the forge's design system

One vocabulary, two surfaces. The web renders it as HTML and CSS; a terminal UI
renders the same names as cells and boxes. If a component is not in this file,
it does not exist — and if you find yourself hand-rolling markup a page already
has a name for, that is the bug.

Read this once. It is short on purpose.

---

## 1. Principles

1. **Border-first, not shadow-first.** Elevation in a light theme is a hairline
   plus a 5%-opacity shadow. In a dark theme it is a lighter surface and a
   stronger border — dark themes have no shadows. If something looks flat in
   the dark, its surface is wrong, not its shadow.
2. **One accent per page.** `--accent` means _interaction_: focus rings, links
   on hover, the active choice. It is never a status color. If two things on a
   page are accent-colored and only one is the action, one of them is wrong.
3. **Hierarchy from weight and color, not size.** 14px does almost everything.
   A title is 20px because it is a title, not to be noticed.
4. **Everything works with JavaScript off.** Script may make a thing instant.
   It may never make a thing possible. A control that does nothing without JS
   is worse than no control.
5. **Anything that navigates is `<a>`; anything that mutates is a `<button>`
   in a `<form method=post>`.** There is no third case, and the CSP forbids
   inventing one.
6. **Never say what you don't know.** A missing thing and a thing you may not
   see are the same 404, with the same words.

---

## 2. Tokens

Palettes live in `src/design/themes.ts`; the stylesheet only ever reads
variables, so a theme is data. Six ship today. What each role _means_:

| token                            | role                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--bg`                           | the page. Nothing else uses it.                                                                                         |
| `--card`                         | any raised surface: card, menu, dialog, input, button.                                                                  |
| `--muted`                        | a recessed surface: row hover, table head, code block, pill.                                                            |
| `--fg`                           | body text, and the **active tab underline**.                                                                            |
| `--muted-fg`                     | all metadata. Never a hardcoded gray — muted is a desaturated hue of the surface, so it warms and cools with the theme. |
| `--faint`                        | decoration only: separators between crumbs, gutter numbers, icons inside rows. Never load-bearing text.                 |
| `--border`                       | every hairline.                                                                                                         |
| `--border-strong`                | a raised edge, and hover on a control.                                                                                  |
| `--primary` / `--primary-fg`     | the one filled button per page, and the live-activity pill.                                                             |
| `--accent` / `--accent-fg`       | interaction: focus ring, link hover, selection, the review-comment rail.                                                |
| `--success`                      | open issue, mergeable pull, additions.                                                                                  |
| `--danger`                       | closed, destructive, deletions.                                                                                         |
| `--merged`                       | a merged pull. Purple, and only that.                                                                                   |
| `--attn`                         | draft, pending, a highlighted line.                                                                                     |
| `--add-*` / `--del-*` / `--wd-*` | the diff. Tints stay ≤14% so syntax color survives on top.                                                              |
| `--tok-*`                        | syntax, in two layers: eleven colour classes every consumer knows, plus finer kinds the web paints over them (§6c).     |
| `--shadow-1` / `--shadow-2`      | a hint and an overlay. Near-transparent in dark palettes, so one rule serves every theme.                               |
| `--series-0…7` / `--qr-ground`   | the same in every theme (`FIXED_TOKENS`): chart series (Okabe–Ito, colour-vision safe) and a QR code's white ground.    |

**Status surfaces are tinted, never saturated**: `color-mix(in srgb, var(--x)
12%, transparent)` for the fill, the pure token for the text, a 34% mix for the
border.

**Contrast targets**: body ≥7:1 where it's cheap, `--muted-fg` ≥4.5:1 on
`--bg`, borders ≥1.5:1 against their surface, focus ring ≥3:1.

---

## 3. Typography

```
--font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
--mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace
```

| role                             | size     | weight | tracking | line-height |
| -------------------------------- | -------- | ------ | -------- | ----------- |
| page title `h1`                  | 20px     | 620    | −0.02em  | 1.25        |
| section `h2`                     | 16px     | 600    | −0.01em  | 1.3         |
| sub `h3`                         | 14px     | 600    | 0        | 1.4         |
| **body, rows, chrome**           | **14px** | 400    | 0        | 1.5         |
| **prose (`.prose` only)**        | **15px** | 400    | 0        | 1.65        |
| metadata                         | 13px     | 400    | 0        | 1.45        |
| mono (code, sha, diff)           | 12.5px   | 400    | 0        | 1.55        |
| micro (`kbd`, `.pill`, `.badge`) | 11.5px   | 500    | 0        | 1           |

Rules:

- **Headings tighten as they grow.** Body text is never tracked.
- `font-variant-numeric: tabular-nums` on every count, date, line number,
  diff stat and file size — a count going 9 → 10 must not shift its neighbours.
  That is `.num`, `.pill`, `.badge`, `.sha`, `.dn`, `.table td`.
- `text-wrap: balance` on headings and empty-state titles; `pretty` on prose
  and descriptions.
- **Truncation is honest**: one line, ellipsis, and a `title` with the whole
  string. Never a fade-out mask — masks lie about whether there is more.
- **A token count is shown where a byte size is shown, never as a badge on
  its own.** Tokens are a unit, like KB: they sit beside a file's size, a
  directory's total, a run's cost or a window's dollars and percentage, so
  the context intuition grows next to the storage and money ones. One
  formatter (`kernel/tokens-format.ts`, rendered by `tokenCount()` /
  `sizeWithTokens()` in `web/ui.ts`) writes them all: `850 tok`, `1.2k tok`,
  `48k tok`, `1.1M tok`. A count the provider reported is bare; an estimate
  (bytes ÷ a stated bytes-per-token ratio for prose, code or data) carries a
  `~`, and every count's `title` says which tokenizer and whether it is an
  estimate. A binary file has no token count — no number beats a wrong one.

---

## 4. Space, radius, motion

- **4px grid.** Every padding, margin and gap is divisible by 4; 6px is allowed
  _inside_ a control. Scale: `2 4 6 8 12 16 24 32 48 64`.
- **Three radii, held to.** `--radius-sm: 6px` on controls (button, input,
  chip, kbd), `--radius: 8px` on surfaces (card, code block), `--radius-lg:
12px` on overlays (menu, dialog, palette), `999px` on pills and avatars.
  A nested element uses the outer radius minus the border width, never the same.
- **Dividers**: `border-top` on `:not(:first-child)`, never `border-bottom` on
  all — that is where the double line at the end of a list comes from.
- **Density**: dense rows (files, commits, issues) 40px; anything touchable is
  ≥44px under `@media (pointer: coarse)` — via padding, so text stays centered.
- **Motion**: 100–200ms, `cubic-bezier(.2,0,0,1)`, enter only. Only `color`,
  `background-color`, `border-color`, `opacity` and `transform` are ever
  animated. Never `height`, never `box-shadow` on scroll. Everything is inside
  the `prefers-reduced-motion` kill switch.
- **Focus** is the accent at 2px with 2px offset, identical on every control,
  and inset (−2px) on full-bleed rows so nothing reflows. Never `outline: none`.
- **Sticky, and only these**: the topbar, a diff file's header, the file path
  header. Everything anchorable carries `scroll-margin-top`.

---

## 5. The component vocabulary

Implemented in `src/web/ui.ts` (pure) and `src/web/chrome.ts` (may read the
database). One class, `data-*` for variants. "Terminal" is the shape the same
component takes in a TUI — a note for the terminal thread to fill in, not a
specification.

| component                                     | web class                                                                                              | variants (`data-*`)                                                                                                                      | states                                                                                                                                                                                                                                             | terminal equivalent                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ | ------ |
| **button** `btn()`                            | `.btn`                                                                                                 | `variant=primary\|secondary\|outline\|ghost\|danger\|link`, `size=sm\|lg`                                                                | hover, active, `:focus-visible`, `[disabled]`, `[aria-busy]`                                                                                                                                                                                       | a labelled key or a highlighted action cell                           |
| **icon button** `iconBtn()`                   | `.btn.btn-icon`                                                                                        | same                                                                                                                                     | `aria-label` required                                                                                                                                                                                                                              | a single glyph with a status-bar hint                                 |
| **input / textarea / select** `field()`       | `.input`                                                                                               | `size=sm`, `[aria-invalid]`                                                                                                              | focus, `:user-invalid`, `[readonly]`                                                                                                                                                                                                               | a line editor with an inline error row                                |
| **form field** `field()`                      | `.field` (`label`, `.hint`, `.error`)                                                                  | `data-invalid`                                                                                                                           | —                                                                                                                                                                                                                                                  | label line, value line, hint line                                     |
| **checkbox**                                  | `.check`                                                                                               | —                                                                                                                                        | native, `accent-color` themed                                                                                                                                                                                                                      | `[x]` / `[ ]`                                                         |
| **badge** `badge()` / `stateBadge()`          | `.badge`                                                                                               | `variant=secondary\|outline\|success\|danger\|merged\|attn`; `data-state=open\|closed`, `data-pr=merged`                                 | —                                                                                                                                                                                                                                                  | a bracketed word in the state color                                   |
| **stat** `stat()` | `.stat` (`.stat-label`, `.stat-value`, `.stat-note`, `.stat-spark`; grid: `.stats`) | `data-tone=attn` | hover (`--border-strong`, only when `href` makes it a link, named by `aria` when given); fixed heights, so a changing value shifts no neighbour; value is `.num` with its full form in `title`; note clamps to two lines, its whole text in `noteTitle`; the sparkline carries its own `role=img` and `aria-label`, or is decorative; `.stats` auto-fits columns of at least 160px | a number under its label, a note under that, an optional sparkline top right |
| **label chip** `labelChip()`                  | `.label`                                                                                               | color via `--label` (see §7)                                                                                                             | —                                                                                                                                                                                                                                                  | a colored `‹name›`                                                    |
| **author** `userLink()` / `userTag()`         | `.byline` (`.byline-name`)                                                                             | —                                                                                                                                        | `userTag` inside anything already a link — see below                                                                                                                                                                                               | `@name` in the avatar hue                                             |
| **name mark** `nameMark()`                    | `.name-mark[data-mark]`                                                                                | `owner` / `crew`, from the account                                                                                                       | never typed: escaped names cannot make it                                                                                                                                                                                                          | beside the name, after the link                                       |
| **avatar** `avatar()`                         | `.avatar`                                                                                              | `size=md\|lg`, `data-h=0..11`                                                                                                            | initials, deterministic hue                                                                                                                                                                                                                        | two initial letters in the same hue                                   |
| **count**                                     | `.count`                                                                                               | —                                                                                                                                        | glyph plus a tabular number                                                                                                                                                                                                                        | `⌸ 3`                                                                 |
| **stat pill** `pill()`                        | `.pill`                                                                                                | `data-tone=accent\|danger`                                                                                                               | tabular                                                                                                                                                                                                                                            | a parenthesised count                                                 |
| **status dot** `dot()`                        | `.dot`                                                                                                 | `data-tone=success\|danger\|attn\|merged`; `data-series=0…7` (`seriesDot()`) is a chart series' swatch, in its `--series-N` colour | —                                                                                                                                                                                                                                                  | `●` in the tone                                                       |
| **sha** `sha()`                               | `.sha`                                                                                                 | —                                                                                                                                        | first 7 chars                                                                                                                                                                                                                                      | the same 7 chars, dim                                                 |
| **progress bar** `progress()` (`pages/milestones.ts`) | `progress` (element rule in `style/components.ts`; every `<progress>` on the site) | — | native `<progress max value>`, 4px, full width, an `aria-label` saying what is done; no width rule per value | `▓▓▓░░ 3 of 5` |
| **meter** `meter()`                          | `meter`                                                                                                | `data-tone=attn` when the share is a limit reached                                                                                        | native `<meter min=0 max=100>`, a whole percentage, an `aria-label` saying what it is a share of; no width rule per value, so no inline style | `▓▓▓░░ 62%`                                                           |
| **kbd** `kbd()`                               | `kbd`                                                                                                  | —                                                                                                                                        | —                                                                                                                                                                                                                                                  | a reverse-video key name                                              |
| **card** `card()` / `listCard()`              | `.card` (`.card-head`, `.card-links`, `.card-body`, `.card-foot`)                                       | `data-tone=success\|danger\|merged\|attn`                                                                                                | —                                                                                                                                                                                                                                                  | a box with a title bar                                                |
| **list row** `row()`                          | `.row` (`.row-lead`, `.row-main`, `.row-title`, `.row-meta`, `.row-trail`, `.row-actions`, `.row-children`; settings: `.setting-list`, `.row-fields`)             | `data-state=open\|closed\|merged\|draft` — colours the **lead glyph**, so a list filtered by state carries no badge repeating the filter | hover, focus, `data-nav`; `fold` makes the row a `<details>`'s `<summary>`, its lead the caret turned when open (/map's lanes); `children` nests the rows under a row in a `<ul class="row-children">` inside its `<li>` — a tree (/family), a step in under a rule, real list nesting for assistive tech; `aria-current="true"` on the `<li>` (`current`) tints the row; `.row-meta` is one honest line: nowrap, ellipsis, `title` — except in a `.setting-list`, where it wraps                                                                                                                                                                | one line: glyph, title, right-aligned meta                            |
| **edit row**                                  | `.edit-row`                                                                                            | —                                                                                                                                        | one line on a desktop, stacked below 720px                                                                                                                                                                                                         | a form line                                                           |
| **colour field**                              | `.color-field`                                                                                         | —                                                                                                                                        | native `<input type=color>` plus its hex; works with no script                                                                                                                                                                                     | a hex entry                                                           |
| **table**                                     | `.table`                                                                                               | `data-dense`; `.num` cells right-aligned                                                                                                                             | —                                                                                                                                                                                                                                                   | aligned columns                                                       |
| **tabs** `tabs()`                             | `.tabs > a`                                                                                            | —                                                                                                                                        | `aria-current="page"` + 2px `--fg` underline                                                                                                                                                                                                       | a header row with the active item underlined                          |
| **segmented control** `seg()`                 | `.seg > a`                                                                                             | —                                                                                                                                        | `aria-current`, or `:has(:checked)` for radios                                                                                                                                                                                                     | `‹ Open                                                               | Closed | All ›` |
| **menu** `menu()`                             | `.menu` (`<details>`)                                                                                  | `data-align=start\|end`                                                                                                                  | open/closed                                                                                                                                                                                                                                        | a popup list                                                          |
| **disclosure** `disclosure()`                 | `.disclosure` (`<details>`, a quiet `›` summary)                                                       | `small` summary, `label` (aria-label), `extra` classes                                                                                   | open/closed; the chevron turns, the summary is at least 44px tall                                                                                                                                                                                  | a folded section                                                      |
| **dialog**                                    | `.dialog`                                                                                              | `data-side=bottom` (sheet)                                                                                                               | JS `showModal()`; every dialog has a real page behind it                                                                                                                                                                                           | a modal box                                                           |
| **tooltip**                                   | `[data-tip]`                                                                                           | `data-tip-side=bottom`                                                                                                                   | hover/focus; hidden on coarse pointers                                                                                                                                                                                                             | a status-bar hint                                                     |
| **toast / flash** `Flash`                     | `.toast`                                                                                               | `data-tone=success\|danger\|attn`                                                                                                        | one per page load, cookie-driven                                                                                                                                                                                                                   | a one-line banner                                                     |
| **command palette**                           | `.palette`                                                                                             | —                                                                                                                                        | JS only; degrades to `/search`                                                                                                                                                                                                                     | a fuzzy-find overlay                                                  |
| **breadcrumb** `crumbs()`                     | `.crumbs`                                                                                              | `.mono`                                                                                                                                  | `aria-current` on the last                                                                                                                                                                                                                         | `a / b / c`                                                           |
| **pagination** `pager()`                      | `.pager`                                                                                               | —                                                                                                                                        | cursor links, absent ends                                                                                                                                                                                                                          | `‹ Newer  Page 2  Older ›`                                            |
| **timeline item** `tlEvent()` / `tlComment()` | `.tl-item`                                                                                             | `data-kind=comment\|event`, `data-tone`                                                                                                  | —                                                                                                                                                                                                                                                  | a card, or one dim line with a glyph                                  |
| **empty state** `empty()`                     | `.card.empty`, title `.empty-title`                                                                    | —                                                                                                                                        | icon, one title, one sentence, **exactly one** action                                                                                                                                                                                              | the same three lines, centered                                        |
| **diff file**                                 | `.diff-file`                                                                                           | `data-status`, `<details open>`, `.diff-viewed`                                                                                          | collapsed, viewed                                                                                                                                                                                                                                  | a foldable file section                                               |
| **code block**                                | `.code`                                                                                                | `:target` / `[data-hl]` line highlight                                                                                                   | —                                                                                                                                                                                                                                                  | a numbered gutter                                                     |
| **prose**                                     | `.prose`                                                                                               | —                                                                                                                                        | 15px, 72ch measure                                                                                                                                                                                                                                 | wrapped markdown                                                      |
| **settings shell** `settingsLayout()`         | `.settings` (`.settings-nav`, `.settings-main`)                                                        | —                                                                                                                                        | sticky nav ≥860px, scroll strip below                                                                                                                                                                                                              | a sidebar and a pane                                                  |
| **repo header** `repoHeader()`                | `.repo-head`                                                                                           | —                                                                                                                                        | tab counts, Settings only for admins                                                                                                                                                                                                               | a title line and a tab row                                            |
| **where strip** `whereStrip()` (`scope.ts`)   | `.where > .where-place`                                                                                | `data-state=reading\|present\|absent` — accent dot, success dot, faint dot — the dot is the place's `aria-hidden` glyph span, its aside `.muted`                                                              | three places, always in this order and these words; a place is a link where one exists, and the third is the pin toggle                                                                                                                            | `● codeberg.org · ● workbench · ◆ this machine`                       |
| **live-browse banner** `liveBanner()`         | `.live-note`                                                                                           | —                                                                                                                                        | only on a live browse, above the content, one sentence                                                                                                                                                                                             | one accent line under the tab row                                     |
| **where-it-lives block**                      | `.where-block`                                                                                         | —                                                                                                                                        | origin, last fetch, Sync now and where pushes land, as one block in the About rail                                                                                                                                                                 | the same four lines under a rule                                      |
| **mirror stages** `stageList()`               | `ol.list.stages[aria-live=polite] > li > .row`                                                                                      | `data-state=done\|now\|todo\|failed` (failed: the stage the job stopped on, a danger "Failed" badge)                                                                                                            | the stage order is the markup order; a script updates it in place and goes to the mirror on done; without JavaScript the same markup renders and a `<noscript>` Reload link re-reads it. Nothing here refreshes itself: no `<meta refresh>`, no timer                                                                                                                                       | a checklist with `●`/`◐`/`○`                                          |
| **origin chip** (`chrome.ts`)                 | `.repo-origin > .origin-chip`                                                                          | the forge's mark: `github` / `forgejo` / `gitea`                                                                                         | the older one-line form, still used off the repo header                                                                                                                                                                                            | one `mirrored from owner/name @ host` fact line                       |
| **origin state badge** `badge()`              | `.badge`                                                                                               | `success` healthy · `danger` needs re-auth · `attn` error                                                                                | the error message sits under the row, never inside the badge                                                                                                                                                                                       | the same three words beside the row                                   |
| **imported author** `originTag()`             | `.byline.origin-by`                                                                                    | the origin's mark instead of an avatar                                                                                                   | never a link to `/name` — that would be a different person                                                                                                                                                                                         | `▲ login`                                                             |
| **pin toggle** `whereRow()`                   | `.repo-where form.where-pin > .btn`                                                                    | `outline` unpinned · `secondary` pinned                                                                                                  | reads `Keep on my machine` / `On my machine ◆`; the strip's third place submits the same form by id, so a `<button>` can sit in a row of links; the wanted state rides the form, so a double submit is idempotent                                  | `p` on a row, `P` on a repo home; `◆` marks a pinned row              |
| **device code**                               | `.device-code`                                                                                         | —                                                                                                                                        | the one deliberately large type in the product: monospace, tabular, `user-select: all`                                                                                                                                                             | the code spaced out and centred in a card, with a spinner under it    |
| **sticky action** `stickyAction()`            | `.sticky-action`                                                                                       | —                                                                                                                                        | static ≥720px                                                                                                                                                                                                                                      | a footer action bar                                                   |
| **count group** `counts()` / `repoCounts()`   | `.counts > .count`                                                                                     | —                                                                                                                                        | icon plus a tabular number; **a zero is never drawn** — the absence is the same information                                                                                                                                                        | `⊙3 ⑂1` after the row title                                           |
| **file explorer** `explorerColumn()`          | `.code-layout` (`.explorer-panel`, `.explorer`, `.ex-dir`, `.ex-file`, `.ex-more`)                     | —                                                                                                                                        | the path's ancestors arrive `open`; the current file is `aria-current`; a folder off the spine holds one `.ex-more` link so it works with no script                                                                                                | a left pane the cursor walks                                          |
| **fuzzy finder** `finderDialog()`             | `.dialog.palette.finder`                                                                               | —                                                                                                                                        | JS only; `t` opens it, the explorer beside it is the fallback                                                                                                                                                                                      | the file picker overlay                                               |
| **file editor**                               | `.editor-form` (`.editor-head`, `.editor-wrap`, `textarea.editor`, `.editor-gutter`, `.editor-commit`) | —                                                                                                                                        | a plain `<textarea>` in a `<form>`; the gutter, tab key, auto-indent and Preview tab are all enhancement                                                                                                                                           | a modal buffer with a commit prompt                                   |
| **branch row**                                | `.branch-row` (`.branch-div` → `.ahead` / `.behind`)                                                   | —                                                                                                                                        | default first, `Default` and `Protected` badges, `↑ahead ↓behind`                                                                                                                                                                                  | one line per branch with the same arrows                              |
| **code hit**                                  | `.code-hit` (`.code-line`, `mark`)                                                                     | —                                                                                                                                        | `path:line` in mono, the matching line beneath it with the query marked                                                                                                                                                                            | the same two lines, the match reversed                                |
| **verdict badge** `verdictBadge()`            | `.badge` / `.badge.verdict-stale`                                                                      | `success` approved · `danger` changes requested · plain commented                                                                        | a verdict passed before the latest push renders `.verdict-stale`: same words, no colour, and the line says "before the latest push". It is history, not a position — and an approval a push dismissed must never look current                      | `[✓ approved]` / `[! changes]`, dim when stale                        |
| **reviews chip**                              | `.reviews-chip`                                                                                        | —                                                                                                                                        | one line inside the merge box: `✓ 2 approvals · ! changes requested by bob · an approval is required`. It names people, because a name is somebody to go and talk to and a number is not                                                           | the same line under the merge verdict                                 |
| **review card**                               | `.card.review-card` (`.review-verdicts`)                                                               | —                                                                                                                                        | one form, radios plus an optional body. Which radios appear is the rule made visible: no Approve for the author, none of the gating verdicts for a reader — both refused in `submitReview` too                                                     | a three-way prompt with a body field                                  |
| **review thread**                             | `.dc-review` (a `card()` per thread)                                                                  | —                                                                                                                                        | open: the comments, then Resolve. Settled: **one line** — `✓ resolved by alice · 2h ago` — with the conversation behind a small `disclosure()` and Unresolve in the card's foot. Resolving is for getting an answered question out of the way of the unanswered ones | a folded thread with a `✓` header                                     |
| **propose card**                              | `fieldset.editor-target.propose` (`.propose-line`)                                                     | —                                                                                                                                        | replaces "Where this lands" when the change is a contribution: the whole outcome in one sentence with **both** repository names, then branch, pull title and pull body. There is no "commit directly" radio, because there is no such option       | the same sentence above the commit prompt                             |
| **run state badge** `runStateBadge()`         | `.badge`                                                                                               | `queued` · `running` (attn) · `ok` (success: _Passed_, or _Done_ for an agent run) · `failed` (danger) · `cancelled` (outline)           | the one badge a check wears on a pull, a run wears in a list, and a log page wears in its head; the log page's script repaints it on `done`                                                                                                        | `[✓ passed]` / `[✗ failed]` / `[· running]`                           |
| **env state badge** `envStateBadge()`         | `.badge`                                                                                               | `stopped` (outline) · `deploying` (attn) · `running` (success) · `failed` (danger)                                                       | what production, or a preview, is doing now; `envTone()` is the same answer as a `dot()` for a list row                                                                                                                                            | the same word in the same tone after the environment's name           |
| **app strip**                                 | `.app-strip`                                                                                           | —                                                                                                                                        | one line under the repo header of a repository that runs: env state badge, `sha`, the production URL as a link **through `…/app/production/open`** (never the bare hostname — a private app would 404), the preview count, the pace (`first preview 2m 14s after New app · in production 9m`, each part once it exists), App (the studio app page)| one line under the where strip: `● running abc1234 · hello.localhost` |
| **environment card**                          | `.card.env-card` (`.env-facts`, `.env-error`)                                                          | `data-tone=danger` when failed                                                                                                           | name and state in the head; `envFacts()` in the body — commit, how fast it came up, uptime, a link to the deploy run, and the deployment's own note and error, each on its own line; Open (or Wake it) below. It is a pull's preview card; the facts and `envActions()` (Redeploy / Stop, writers only) are functions, not markup, so the studio head and its preview rows render the same ones                                 | a box per environment with the same three lines                       |
| **checks line**                               | `.checks-line` (`.ok`, `.bad`, `.now`)                                                                 | —                                                                                                                                        | inside the merge box, in the reviews chip's voice: `✓ Checks passed · deploy abc1234 · a passing deploy is required`. Rendered only where the repository runs as an app or requires checks; a merge box gains _Waiting on checks_                  | the same line under the review line                                   |
| **run log**                                   | `pre.run-log`                                                                                          | `data-run` while the run is going                                                                                                        | the log as written, wrapped so a phone never scrolls sideways; a script appends the run's lines from the page's one `/events` stream and follows the bottom until the reader scrolls up; the page never reloads itself | a scrolling pane that follows the tail                                |
| **assignee card**                             | `.card` with an `.edit-row` form                                                                       | —                                                                                                                                        | who is on it, then one select and one button for a writer. People first, the crew last and marked `(agent)`, because assigning an agent is what starts it working and the choice is not the same kind of choice                                    | a picker with people, then agents                                     |
| **inbox** (`asks_page.ts`)                    | one list above the feed                                                                                | —                                                                                                                                        | _On you_: what asks you and what is assigned to you, one row each, each with what it waits for (`needsYouSection`), and one count in the top bar. Absent when empty: a card saying nothing is a zero drawn                                         | the same two panes on the dashboard                                   |
| **look** (`pages/looks.ts`)                  | `.look` in a `.looks` strip                                                                            | `.look[data-slot=phone\|desktop\|thumb\|now]` sizes the frame; `.looks[data-compare]` sets two sides (before · main, then after · the pull) beside each other | a picture always carries its own `width`/`height`, so nothing shifts when it loads; a phone keeps 200px, a desktop takes the rest up to its own size, and under 640px a strip stacks; an attached picture is a `figure` in the strip with its line under it | the picture in the terminal (§6·0c)                                   |
| **board** (`pages/board.ts`)                  | `.board` (`.board-grid`, `.board-region`)                                                              | `data-wall` (across the room: no keys, no pointer, larger), `data-focus=working\|landed\|decided\|today`                               | the one whole-screen layout: four live regions fill a second monitor ≥1100px and each list scrolls on its own, one column below; above the panels only a collapsed one-line `#notes` (`<details>`: closed by default, an open list stays open across live swaps), the strips below them; inside, only §5 parts (list card rows, badges, meters, `kbd`); a swapped region's heading wears `data-fresh` for a moment | four panes, one focused by its number                                 |
| **stacked bar chart** `windowSvg()` (`fleet-graph.ts`) | `.plots`, `.plot` (`.plot-name`), `.plot-legend` | bars wear `fg-sN`, the `--series-N` token | server-drawn SVG with `width`/`height` set, so it holds its box before the stylesheet; gridlines `--border`, figures `--muted-fg` in mono, panel names `--faint`; `role="img"` with an `aria-label` totalling it, a `<title>` per bar, and a table of the same numbers beside it | a table of the same numbers |
| **chart** `chartBox()` (`ui.ts`) | `.chart-box` wrapping `drawChart`'s svg `.chart` (`.big` for the headline figure) | `.is-table` for a table panel | one query or series drawn on the server: the svg carries its own `width`/`height` and the box holds its space, so nothing shifts; `role="img"` with an `aria-label` of its title. Reach for it wherever a page draws a `boards/chart.ts` chart — `/system`'s memory pair and every board panel — and size it from the page (`.bp-*`, `.plots`, `.bgrid`), never inside the frame | the same numbers as a table |

Two things are deliberately **not** in the vocabulary: skeleton loaders (the
server renders whole pages — there is nothing to skeletonise) and a custom
switch control (a native checkbox with `accent-color` is themed, keyboard-correct
and honest about what it is).

Three rules the browser enforces whether or not you meant them:

- **A name says who it is, and nobody types that.** Beside the owner's name
  and each agent's, `userLink()` wears a `nameMark()` — `owner`, `crew` —
  drawn from the account (`core/marks.ts`: an admin who is a person; an
  agent), never from a display name. Every name is escaped, so no typed word,
  alphabet or emoji produces the `data-mark` element; a byline without one is
  nobody the mark vouches for. A page asks `marksByName()` once for the names
  it will show. `test/name-marks.test.ts` tries the disguises.
- **A link inside a link is not a link.** `<a>` nested in `<a>` is not merely
  invalid — the parser closes the outer anchor and re-parents everything after
  it as a _sibling_, so the row visibly falls apart. Anything rendered inside a
  linked `.row` uses the non-anchor form: `userTag()`, not `userLink()`; plain
  text, not a repo link. `test/web-ui.test.ts` sweeps the list pages for it.
- **Whitespace is content inside `white-space: pre`.** The diff cell (`.dc`) is
  pre-formatted, so a pretty-printer's newline between `<td>` and its span
  renders as a blank line and an indent. Assemble such a cell into one value
  and interpolate it whole; `.dcx` holds the `pre`, so a stray newline costs a
  collapsed space rather than a broken line.
- **A grid or flex item's automatic minimum size is its content.** A column
  holding one long unbreakable line pushes the page wider than the phone
  instead of letting its own ellipsis work. Every page grid sets
  `min-width: 0` on its children.

### 5a. Saying where you are reading from

Every repository page in the product carries the **where strip**, and it says
the same three things in the same order however you got there:

```
● codeberg.org · ○ workbench · ○ this machine        browsing live, read-only
● codeberg.org · ● workbench (synced 3m ago) · ◆ this machine    a mirror you keep
● workbench · ○ this machine                          a repository born here
```

- **Filled `●` means present, hollow `○` means absent, `◆` means kept on this
  machine.** The dot carries the colour; the word never does, so a strip reads
  as one fact rather than three competing badges.
- **Accent marks the place these bytes came from.** That is the page's own
  subject, which is the one thing accent is allowed to be besides interaction
  (§1.2). Exactly one place per strip wears it.
- **Every place is a link where one exists**: the origin goes to the repository
  on that forge, the workbench to the mirror here, and "this machine" submits
  the pin toggle.
- A repository that is **your fork of** another one says so in the strip, as
  the origin place's aside: `● codeberg.org (fork of octo/widgets)`. The About
  rail carries the same fact as a linked `Fork of` row — the strip is for
  orienting, the rail is for going there.
- A live browse also carries `.live-note` above the content, saying it is
  read-only and what to do about that. There is no second way to find out: a
  live page renders no composer, no state form, no labels form, no merge box
  and no settings tab, because `RepoSource` has no mutation on it to submit to.
  The three forms it does carry — Mirror, Fork, Propose a change — create
  something **for you**: a copy here, a fork of your own there, a proposal on
  it. None of them changes the repository being read.

The strip is the visible half of `RepoScope` (`src/web/scope.ts`); the pages it
sits on are the same renderers for both sides of the world, and a divergence
between a live browse and the repository we hold would be a bug you could see.

### 5b. The workflow units

A unit is a whole intention with one button behind it, not a sequence of
screens you assemble yourself. Five of them, and the web renders each as one
form:

**Fork** — on a live browse and on every picker row you cannot push to. It
POSTs `…/fork`, forks at the origin, and answers with the mirror job page,
exactly as Mirror does, because the local copy of a fork is a job with stages.
The flash names both halves and the host: `Forked octo/widgets to me/widgets at
codeberg.org.` Not offered on a repository the connected account already owns —
neither forge forks you to yourself. A native repo keeps its own `…/fork`.

**Propose a change** — where the origin says you may not push, Edit and New
file become Propose a change and open the ordinary editor with the propose card
under it. One POST to `…/contribute` forks if needed, branches on the fork,
commits, and opens the pull upstream with the `owner:branch` head form. You land
on the pull: its page here if we mirror the upstream, its live-browse page if we
do not — never thrown out to another forge mid-workflow. Every refusal
re-renders the editor with the text still in the textarea (`§6c`'s rule: never
lose a keystroke).

**Pass a verdict** — the review card, one POST to `…/review-state`. Verdicts
land in the timeline as `verdictBadge` items in time order with the comments and
the state changes, because a verdict is a thing that happened at a time.

**Settle a thread** — every review comment sharing an anchor is one
conversation, resolved by a writer or by anybody in it, at
`…/threads/:anchor/{resolve,unresolve}`. The files header counts them:
`3 threads · 1 unresolved`.

**Merge, or not** — the merge box gains a sixth state, _Waiting on review_,
whenever `require_review` is unsatisfied or a change is outstanding. The button
is disabled and the chip says who to talk to; the refusal is `mergePull`'s
(`review_required`), and the disabled button is only the honest preview of it.
`Require an approving review before merging` is a checkbox in General settings.

One rule holds all five: **the page never decides.** Every affordance here is
rendered from the same answer the action will give — `permissions.push` for
propose, `status.reviews` for the gate, `canWrite` plus thread authorship for
resolve — so a button that is absent and a call that is refused are the same
fact said twice, and never two different facts.

### 5c. Apps, runs and the crew

`docs/APPS.md` is the contract; these are its units on a page, and the same
rule holds: the page never decides. Six of them:

**New app** — `/apps/new`, one form: a name, a sentence about what it should
do, visibility, and an agent from the crew when there is one. One POST makes
the repository with a working app in it, makes it an app, starts production,
and — with a sentence and an agent — opens issue #1 assigned. The flash names
the production URL and the agent. A forge with no agents says so on the form
in one line and offers the same button without the select.

**Run as an app** — on a repository's settings, the App section: enable with a
slug, an access choice and the preview-data policy; edit them; disable behind
a confirm page. The app strip (§5) appears on the repository the moment it is
on.

**Open** — never the bare hostname. Every link to an environment goes through
`…/app/:env/open`, which checks `canRead` and answers with the URL — carrying a
grant for a private app — so the same link works for a public app and a
private one and a stranger gets `not_found` from the forge rather than a
guess at a hostname.

**Redeploy / Stop** — two POSTs on the studio app page (`studio/app.ts`;
dev's old `/:owner/:name/app` redirects there), writers only: production's
in the head card, each preview's on its row; a stop keeps the data (a
redeploy brings it back), a stopped environment shows the honest word and
the run that stopped it.

**Assign** — the assignee card on an issue and a pull: nobody, then people
who can read the repository, then the crew marked as agents. Assigning an
agent is the dispatch, so the select says so beside the crew. An agent's own
pull opens already assigned to it.

**Cancel a run** — one POST on the run page while it is unfinished; the log
keeps everything up to the cancel and the badge says `cancelled`.

The merge box gains a seventh state, _Waiting on checks_, when
`require_checks` is on and the head's deploy is not green; the refusal is
`mergePull`'s (`checks_required`) and the chip links the run. A pull's
**Preview** card and its **Checks** line read the same run rows a
`runStateBadge` does elsewhere — a check is a deploy, never a separate
object that can drift.

**Website spec findings** — under a pull's Checks line, from the preview's
latest deploy run (`core/preview_findings.ts`): a **disclosure** whose
summary is the count (edge-owned findings counted apart) and whose body is
a `.list` of `.row`s, one per finding, with its specification.website
section as an https link. Report-only, so the words never say failed; the
summary is at least 44px tall for a thumb. The terminal says the same count
at the end of the checks row.

### 5d. Page-local classes

The close form on an issue's thread is no class at all: its reason select and
"close into" input are plain §5 inputs, the height of the Comment button beside them, and `style/content.ts` shows the
input only while "split into…" is chosen, by attribute selector inside
`.form-actions` (`select[name="reason"]`, `input[name="into"]`). It is a rule
about the form, not a component.

Every class a stylesheet defines is named in this section (`bun
scripts/design-lint.ts` fails one that is not, #2700). The table above is
the vocabulary; the classes below are what pages built beside it before that
rule held. They are registered, not endorsed: each belongs to the file it is
listed under, and a new page reaches for §5's components instead of
borrowing one. The plan (`docs/design/plan.md`) retires them page by page —
onto a §5 component, or into the table when a page-local thing turns out to
be a component — and the check fails a name kept here after its last rule is
gone, so this list only shrinks. Each class sits on its own line, so to
retire a class, delete its line: two pulls retiring two classes never edit
the same line (#4888).

- **`style/base.ts`** — the page shell (topbar, main, footer) and the layout and text utilities every page leans on:
  - `.bar`
  - `.bare`
  - `.foot`
  - `.grow`
  - `.hide-sm`
  - `.js-only`
  - `.mb`
  - `.mt`
  - `.narrow`
  - `.narrow-wide`
  - `.reduced`
  - `.shell`
  - `.skip`
  - `.spacer`
  - `.stack`
  - `.stack-tight`
  - `.topbar`
  - `.wordmark`

  A `.field` directly inside a `.bar` drops its bottom margin and the bar aligns to the end, so a labelled input and its button share a baseline
- **`style/components.ts`** — parts of the §5 components that the table does not spell out — the palette's list, the menu's items, a dialog's head and foot, comments, the theme picker — and a few small helpers beside them:
  - `.cat`
  - `.error-note`
  - `.ico`
  - `.ico-loader`
  - `.list`
  - `.menu-item`
  - `.menu-panel`
  - `.menu-sep`
  - `.menu-title`
  - `.palette-foot`
  - `.palette-input`
  - `.palette-list`
  - `.preview`
  - `.sep`
  - `.split`
  - `.sprite`
  - `.swatch`
  - `.table-scroll`
  - `.theme-apply`
  - `.theme-option`
  - `.tick`
  - `.toast-body`

  `.split` is the one two-column page: main, then an `<aside>` rail of 260px that sticks from 960px. `data-rail="wide"` on it (the studio's home and an app's page) widens the rail to 320px from 900px, drops the top margin, and lets the rail scroll with the page, since a column of cards runs taller than a screen
- **`style/content.ts`, page furniture** — what frames a page's content: page and repo heads, the front page and its tiles, explore, backups, boards, the fleet chart's series colours, lineage:
  - `.bgrid`
  - `.bmanage`
  - `.bp-h2`
  - `.bp-h3`
  - `.bp-w2`
  - `.bp-w3`
  - `.break`
  - `.commit-body`
  - `.commit-head`
  - `.domain-records`
  - `.filters`
  - `.front-admin`
  - `.front-crew`
  - `.front-issues`
  - `.front-live`
  - `.front-more`
  - `.front-pick`
  - `.owner`
  - `.page-head`
  - `.policy-line`
  - `.repo-actions`
  - `.repo-desc`
  - `.repo-layout`
  - `.repo-lineage`
  - `.repo-title`
  - `.slash`
  - `.sub`
  - `.tok`
  - `.where-sep`
- **`style/content.ts`, code view** — the source view and the syntax-highlight token classes `highlight-html.ts` builds as `tok-${kind}`:
  - `.ln`
  - `.tok-deleted`
  - `.tok-inserted`
- **`style/content.ts`, prose (markdown)** — table cell alignment, built by `markdown.ts` as `ta-${align}`:
  - `.ta-c`
  - `.ta-r`
- **`style/content.ts`, diff viewer** — the diff table: its gutters, line kinds, file head and inline review comments:
  - `.add`
  - `.del`
  - `.dh`
  - `.diff`
  - `.dl`
  - `.dn`
  - `.wd`
- **`style/content.ts`, apps, runs, and the crew** — run pages, their logs and checks (a pull's look is §5's **look**).
- **`pages/board.ts`** — the board itself is §5's **board**; the spend tables `spend.ts` draws wear §5's `.table` and `.stack`, no class of their own
- **`studio/feed_style.ts`** — the home feed's cards and its composer (the apps rail is §5's card, row and btn; an admin's tick boxes and Archive are always shown, deliberately, with no Select toggle):
  - `.feed`
---

## 6. Keyboard

Driven entirely from the DOM: `data-shortcut="g i"` on a link, `data-nav` on a
row. The `?` overlay is generated by walking `[data-shortcut]`, so the help can
never drift from the app.

| key             | action                                         |
| --------------- | ---------------------------------------------- |
| `g h`           | home                                           |
| `g c`           | repo code                                      |
| `g i`           | issues                                         |
| `g p`           | pull requests                                  |
| `g m`           | commits                                        |
| `g b`           | branches                                       |
| `g s`           | repo settings                                  |
| `j` / `k`       | next / previous row (visible focus ring)       |
| `o` or `Enter`  | open the focused row                           |
| `c`             | the page's create action (new issue, new pull) |
| `t`             | go to file (the fuzzy finder), on a code page  |
| `e`             | edit the file you are looking at               |
| `/`             | focus search                                   |
| `⌘K` / `Ctrl K` | command palette                                |
| `?`             | shortcut help                                  |
| `Esc`           | close a menu or dialog, blur a field           |

Inside the code view, shift-clicking a second line number extends `#L3` to
`#L3-L9` and highlights the range.

`t` and `e` are not a new key layer: they are `data-shortcut` attributes on
the real controls, so the `?` overlay learns them for free and a page without
those controls does not answer the key. `j`/`k` are the shell's own row
traversal, and the explorer's files are `data-nav` rows — which is why
arrowing through the tree previews as you go without a single extra key
handler: `codeJs` listens for **focus**, not for keys.

### 6a. The code browser

Tree and blob pages are one layout, not two: a `.code-layout` grid with the
explorer on the left and the content on the right at ≥900px, the explorer
folding into a "Files" `<details>` above the content below it.

- **The spine, not the tree.** A page renders the path's ancestors and their
  siblings, never the whole repository, so a monorepo costs the same markup as
  a toy. Every directory is a `<details>`; the ones on the spine arrive open.
- **A folder the server did not expand is still a link.** Opening one with no
  script shows a single `Open src/…` link to that folder's own page; with a
  script, `codeJs` fetches `?fragment=explorer` and drops the rows in.
- **The preview is the page.** Hovering or arrowing a file fetches the blob
  route's own `?fragment=1` — the same renderer, the same markup, the same
  `#code-pane` — so a preview and a real navigation are indistinguishable, and
  `enter` simply follows the link that was already there. Fetches are
  cancelled and cached, and there is no scroll-stealing or URL rewriting.
- **The explorer opens closed and the stylesheet opens it.** `<details>`
  without `open`, plus `::details-content { content-visibility: visible }` at
  ≥900px. Where that pseudo-element is understood the handle is hidden too;
  where it is not, the handle stays and one click opens the column. Nothing
  can end up invisible with no way back.
- **The finder is a dialog over JSON.** `t` (or the button) fetches
  `/:owner/:name/paths/:ref` once and scores it client-side with fzf's
  FuzzyMatchV2 constants under its `path` scheme — boundary 8, delimiter 9,
  camel 7, consecutive 4, match 16, gap −1, first character doubled, string
  start treated as though it followed a `/` — on top of a 28-bit
  characters-present bitmask prefilter and a two-pointer subsequence check, so
  the affine-gap DP only ever runs on real candidates. VS Code's tiering sits
  above the score rather than inside it: any match inside a file's own name
  outranks any match that only lands in its directories, and a basename
  _prefix_ outranks that again. Without a script the finder does not exist and
  the explorer beside it is the answer.

### 6b. Code, coloured

One tokenizer, `src/web/highlight.ts`, serves the file browser, the diff
viewer, Markdown fences, the terminal UI and the browser bundle the editor
loads. It is a stateful per-line scanner over rule tables — Prism's model, not
a parser — and it is bound by three properties the tests assert for every
language: **lossless** (a line's tokens concatenate back to the line),
**linear** (10,000 characters in well under a millisecond, no backtracking
regex), and **total** (random bytes never throw).

Roughly thirty languages have rule tables, including the ones a forge actually
holds: ts/tsx/js/jsx (template literals, regex-versus-division, decorators,
JSX tags), python, go, rust, c/c++/objective-c, java, kotlin, swift, ruby,
php, lua, zig, elixir, nix, sql, json/jsonc, yaml, toml, ini, markdown,
css/scss, html, shell, dockerfile, makefile and diff. Detection is by
extension, then by whole filename (`Dockerfile`, `Makefile`, `.zshrc`), then —
only for a file that has said nothing else — by shebang or editor modeline:
`detectLanguage(path, firstLine)`.

**Two levels of token.** `cls` is the colour _every_ consumer understands —
`keyword string comment number function type operator punctuation constant
meta plain` — and it is what the terminal's theme table maps. `kind` is a
refinement only the web paints: `property tag attribute regex variable
decorator heading emphasis link inserted deleted`. A token renders as
`class="tok-<cls> tok-<kind>"`, the kind rule comes last in the stylesheet and
so wins at equal specificity, and dropping the kind leaves a page that is less
specific but never wrong. That is the whole reason the vocabulary can grow on
the web without the terminal having to agree first.

Punctuation and operators are deliberately **below** body colour
(`--tok-punctuation`, `--tok-operator`): they are a line's scaffolding, and
colouring them loudly makes code shout. Diff-inside-a-fence borrows the diff
tints (`--add-fg` / `--del-fg`) rather than inventing a colour.

**Markdown has two right answers.** A `.md` blob renders as prose by default
and offers `Source | Rendered` in its path header; `?view=source` is a plain
link, so both halves work with no JavaScript, are addressable, and survive
being sent to somebody. The rendered half is the README renderer — fenced code
is highlighted in the language the fence names, tables are tables, and a
relative link (`docs/keeping.md`) resolves, while anything carrying a scheme
other than http(s), or a protocol-relative `//host`, is left as text.

### 6c. The editor

`GET /:owner/:name/edit/:ref/*path` is a `<textarea>` in a `<form>`, and one
rule governs it: **a refusal never costs you your typing.** A protected
branch, a file over the size cap, a branch name git will not take, an origin
that said no — each re-renders the same page with the text, the message, the
branch name and the pull-request fields exactly as they were, and the reason
above them. `test/web-editor.test.ts` asserts that, not just the happy path.

The commit box is one submit, because `editFiles` is one call: message,
target (`current branch` / `new branch <name>`, defaulting to
`alice/edit-<file>`), and optionally a pull request from the new branch back
to where you started. Where committing straight to the ref is not on offer at
all — a protected default, or a ref that is not a branch — the page says so on
the disabled radio rather than letting somebody find out after typing.

**The highlighted mirror.** Under the textarea sits a
`<pre id="editor-mirror">` holding the same text, syntax-coloured; the
textarea on top of it has transparent text and a visible caret. They share one grid cell and one set
of metrics — font, size, line height, padding, tab size — because a single
divergence puts the caret in the wrong place, and the _height ceiling lives on
`.editor-wrap`_ so the gutter, the mirror and the textarea are always the same
height and scroll as one. The mirror is rendered by the server for the first
paint, so there is no flash of uncoloured code, and kept in step by
`window.forgeHighlight`, which is `web/highlight.ts` itself bundled by
`Bun.build` at first use and served from `/assets/highlight-<hash>.js`,
immutable. That asset is the one thing that relaxes the script CSP — from
"this page's nonce" to "this page's nonce, or a file from this origin" — and
only the editor page asks for it.

An edit re-scans from the first changed line and stops as soon as the state
entering an unchanged line matches what it was before, so typing costs one
line's work; the DOM is patched line by line rather than rebuilt. Tab inserts,
Enter keeps your indentation, brackets and quotes close themselves (and wrap a
selection), `⌘/Ctrl+S` submits the commit form, and the current line is
marked. `⌘/Ctrl+F` is left to the browser on purpose: the mirror holds real
text, so the page's own find lands on the line you were looking for.

**It degrades, in that order.** Over 200 KB or over 10,000 lines the server
sends no mirror and no bundle — a file that size is not hand-edited in a
browser, and a slow editor is worse than an unhighlighted one. If the bundle
fails to build or never loads, the page keeps the plain textarea, because the
textarea's own text only turns transparent once the mirror is live. With no
JavaScript at all it is a `<textarea>` in a `<form>`, which is what it was
before any of this. The Preview tab is offered on Markdown only, and renders
through the same `/preview` fragment the server will use for the file.

**Origins are web-only.** Connecting, syncing and browsing an origin live on the web pages (`/origins`) and in migrate; the terminal has no origins screen. On a mirrored repo's home `y` syncs the mirror and `P` pins it — `p` has meant _pulls_ on that
screen since before pins existed, so the toggle takes the shifted key there
and the plain `p` everywhere a repo is a _row_ (the dashboard, explore).

The connect chooser is ordered by what actually gets somebody connected:
**Personal access token — recommended** first (paste a string, no setup at
all), then **GitHub, one click** (needs a one-time OAuth app setup) and
**Forgejo / Gitea, one click** (needs an app registration on the instance).
Each row carries that condition on its own line rather than failing later
with an error about an environment variable.

**The where strip.** Every repository screen carries one line directly under
its title, naming the three places a repository can be and marking which one
the bytes on screen came from:

```
● codeberg.org  ·  ○ workbench  ·  ○ this machine
reading live from codeberg.org — read-only · m mirror into your workbench

● codeberg.org  ·  ● workbench (synced 3m ago)  ·  ◆ this machine

● workbench  ·  ○ this machine
```

The first is a live browse (and only a live browse gets the second, muted
banner line); the second is a mirror that is also pinned; the third is a
native repository, which has no origin and therefore no first place. The dot
is the grammar — **accent** is the place being read from, **success** is a
place that has this repository, **muted** is a place that does not:

| glyph | means                                                      |
| ----- | ---------------------------------------------------------- |
| `●`   | this place has the repository (accent = reading from here) |
| `○`   | this place does not have it                                |
| `◆`   | kept on your machine (pinned)                              |
| `▲`   | this came from the origin — an imported author or activity |

**Read-only means read-only.** A screen over a live source has no write keys
at all — no `c` comment, no `x`/`o` state, no `l` labels, no `m` merge, no
`,` settings, no `F` fork — because `capabilities.write` is false and the
source has no method that could write. In their place the help bar shows
`m mirror` and `O open on origin` — first, ahead of the navigation keys,
because at 80 columns the bar has room for about six bindings and those two
are the only things you can actually do here. The banner carries the long
wording; `w` opens the workbench copy when one already exists.

**The mirror card.** `m` opens a checklist over whatever screen you were on:
`creating → fetching → labels → issues → pulls → comments`, a spinner on the
stage in progress with the job's own words beside it ("42 issues"), and the
elapsed time. `esc` hides it and the mirror keeps running, toasting when it
lands; on `done` the live screen underneath is replaced in place by the same
screen over the local source, and the strip flips to `● workbench`; on
`failed` the card shows the scrubbed reason and `r` retries.

### 6·0. The pointer

The terminal UI is keyboard-first and mouse-**complete**: everything you can
see is something you can click, and clicking never reaches somewhere the
keyboard could not. Reporting is on from the moment a session starts
(`?1000h ?1002h ?1006h`, SGR coordinates last) and off before the alt screen
is left. The one cost is real and is said out loud in the `?` overlay:
**shift-drag** is now how you select text, because the terminal's own
selection is what mouse reporting takes away.

**The model is a hit table rebuilt every frame.** During `render`, a screen
claims rectangles with `ctx.hit(rect, handler)`:

```ts
ctx.hit(rect, (e) => open(rows[e.y])); // click only
ctx.hit(rect, { click, wheel }); // and the wheel
```

The registry is cleared at the top of every paint and rebuilt by whoever
draws, so a region can never outlive the pixels it stands for — the bug every
retained hit table eventually has. Regions are searched **newest-first**, so
whatever drew last is what a click reaches: an overlay draws after the screen
beneath it, and needs no z-index to win. A region that does not handle _this_
gesture is not in the way of one that does, so the wheel over a clickable row
still scrolls the list the row is in.

Four rules hold the gestures together:

- **A click selects; a second click on the selected row opens it.** So does a
  double-click on any row. A single click has to be safe, because half of
  pointing at a row is looking at it, and a list where looking navigates is a
  list you cannot browse.
- **One notch is three rows**, delivered to the region under the pointer. A
  notch nobody claimed falls back to arrow keys, which is what a wheel has
  always meant.
- **Mouse input is never a synthetic keystroke.** Nothing reaches
  `Screen.key`; a screen that wants a click says so with `ctx.hit`. The
  keyboard behaviour of every screen is unchanged by any of this.
- **A click on an overlay's dimmed backdrop dismisses it**, and does not reach
  the row underneath.

Clickable today: every list row, the dashboard's four panes, the workspace's
explorer rows and tab chips (including the active tab's `✗`), the file pane
(focus, and the wheel), the where-strip's three places, the palette's results,
the appearance picker's rows, the owner, refs, settings, account
lists, the pull's diff-and-threads pane, and **every
hint in the help bar** — clicking a hint presses the key it names, taken from
the binding itself so a label can never drift from the action. A list with no
`hitList` is a bug, not a design decision: "everything you can see is
something you can click" is the whole claim.

### 6·0a. The dashboard's panes

`Repositories`, `Recent activity`, `On you`, `On your machine`,
`Organizations`. What is running is the studio's question, on the web; the
terminal's dashboard is the code and the conversations. Each is a pane with its own cursor: `tab` / `shift+tab` cycles, the focused one wears
the accent frame, `j`/`k` move inside it and `enter` opens what it is pointing
at — an activity row opens **the issue, pull or repository it is about**, a
pin opens its repository, an organization opens its page. `d` on a pinned row
unpins it (asking first). A click does all of the same. Below 100 columns the
activity feed stacks under the repository list and the three small cards wait
for a wider window; shorter than twelve body rows, the repositories have the
whole body. `tab` reaches exactly the panes the last frame drew: a focus ring
on a card that is not on screen is worse than no focus ring.

### 6·0a·1. Laid out for the terminal it is in

Three numbers in `ui/layout.ts` decide every screen's shape, so every screen
folds at the same width and none invents its own. At **100 columns** a list
sits beside its detail; below, `beside()` stacks the two with the detail
underneath (two fifths of the height unless the screen says otherwise), and
drops it only when there are fewer than twelve rows to share. Under **40×10**
no layout survives — a card is narrower than its title — so one line says what
would help, and every screen keeps its state for the moment the window grows.

A resize re-lays the current screen at once and loses nothing: a list keeps
its cursor and scrolls it back into view, a log keeps the _line_ at the top
of the reader's window whatever number of rows it now wraps to, and a program
holding the pty (`$FORGE_EDITOR`, an app's `tty`) hears the new size before
the UI does. Long text wraps or ends in an ellipsis at the width, never past
it. A row's meta gives way before its title starves — the leading pieces
(`metaOf` order: a commit, then a cost, then the time) go first, the last one
last — and a table's ranked columns (`drop`) are given up lowest first, the
same word `local/rows.ts` uses.

An activity row is one line, not two, because a row is a thing you can put a
cursor on: `who did what · the object`, with the time in a fixed right-hand
column. The headline already ends with `#4`, so the object drops the repeated
number rather than truncating the title.

### 6·0b. Icons, and the appearance picker

Two vocabularies. **`plain`** is the safe set (§6a) — BMP, width 1, in every
default terminal font. **`nerd`** is the same vocabulary drawn from a Nerd
Font, which is a bet on the reader's _font_, a thing `TERM` cannot tell us.
`auto` takes the bet on Ghostty, kitty and WezTerm, because those are
terminals people install deliberately and installing a Nerd Font is the next
thing those people do. Everything else gets `plain`.

The bet is bounded: every glyph in both sets is exactly one cell (asserted by
`test/tui-icons.test.ts`, since every Nerd codepoint lives in a Private Use
Area that `width.ts` measures as width 1), so a missing glyph is one tofu box
and never a shifted row. Where the two sets would say different things, the
plain set keeps the documented grammar: `◆` still means "kept on your
machine", and an unpinned row still wears nothing.

`ctrl+t` opens **Appearance**: the six themes, then two more rows —

| row      | values                                        |
| -------- | --------------------------------------------- |
| `Images` | `auto (kitty)` · kitty · sixel · iterm · none |
| `Icons`  | `auto (nerd)` · nerd · plain                  |

`j`/`k` move, `left`/`right`/`enter` cycle a setting's value, a theme applies
as the cursor passes over it, and both settings persist through
`setPreference` into `user_setting`. It is `ctrl+t` and not `t` because the
workspace already spends `t` on the file finder, and an appearance picker
that silently does nothing on the one screen people live in is worse than a
modifier: one key, every screen, whatever has focus. Under the rows is a **live preview** —
three real icons in the set currently chosen — because the only honest way to
settle a bet about somebody's font is to show them three glyphs and let them
look. If they see boxes, one keypress puts it back.

### 6·0c. Pictures in the terminal

A tab whose path looks like an image and whose bytes git returned as binary is
a **picture tab**. Where the terminal can show pixels it does
(§`term/graphics.ts`: kitty for Ghostty/kitty/WezTerm, sixel where detected,
iTerm2 by setting); where it cannot, a placeholder card names the format, the
geometry and the size, and says plainly what would show it.

The loop owns the lifecycle. A screen calls `ctx.placeImage(placement)` during
render and the bytes go out **after** the frame, raw; not calling it removes
whatever the last frame placed. That one rule makes a tab switch, a close, a
`pop`, a resize and a theme change all clean up by themselves, with no screen
having to remember to. A placement is re-sent only when it is genuinely new —
a different image, a different rectangle, or a repaint that invalidated
everything — because `drawImage` reserves its cells with the theme ground and
an ordinary frame emits nothing over them. Re-sending a megabyte of base64 on
every keystroke is the one thing that would make pictures unusable over SSH.

Aspect ratio comes from the client's own `pty-req` / `window-change` pixel
fields when it sends them (most send zeros), and from the 1:2 guess otherwise.

`v` toggles a picture between the pixels and the facts about the file.

### 6a. Counts and marks on a row

Three glyphs carry the at-a-glance numbers, all of them BMP, all width 1, all
present in every default terminal font in wide use — no Nerd Font (we cannot
assume a patched font over SSH) and no emoji (their width is genuinely
inconsistent, and one column of error shifts an entire row):

| glyph | means       | where                    |
| ----- | ----------- | ------------------------ |
| `○`   | open issues | every repo row           |
| `↳`   | open pulls  | every repo row           |
| `▭`   | comments    | every issue and pull row |

They render muted, right-aligned in the row's meta column, and **tabular**:
the widths are computed once across the whole page so the numbers form a
column instead of jittering row to row. **Zero is absent, not `○ 0`** — an
empty queue should read as quiet, and a column of zeroes reads as noise.

The numbers come from grouped reads (`countsForRepos` / `withCounts`,
`commentCountsFor`) and never from a query per row. `test/counts.test.ts` and
`test/tui-code.test.ts` both assert that; a list is where N+1 hurts most.

### 6b. The workspace — one screen for a whole repository

Opening a repository in the terminal opens a **workspace**, not a home page:
the explorer, a tab bar, the file you are reading, and the one commit that
carries everything you changed. There is no repo card to leave, no directory
screen to push, no blob screen under it and no editor screen on top. The four
screens that used to be there were four escapes deep and lost your place at
each one.

```
 forge                                                                          Ink
alice › alice/lighthouse
● workbench  ·  ○ this machine                                              main ▾
 README.md   src/lamp.ts ●   src/weather.ts                                 3 tabs
▾ src/            ┃  1 # Lighthouse
    lamp.ts     ● ┃  2
    weather.ts    ┃  3 A beacon. Rotates the lamp, logs the weather, warns the ships.
  package.json    ┃
▸ README.md       ┃
 main · 1 modified                                        src/lamp.ts · 22 lines
  tab focus explorer   e edit   c commit   b switch ref   t find file   i issues
```

The where strip keeps column zero, exactly as it does on every other
repository screen, and the ref pill (`main ▾`) takes the right-hand end of the
same row. At **≥100 columns** the explorer is a column beside the file; below
that it is the pane `tab` toggles onto, never both at once. A repository opens
on its **README** — the first file at the root if there is none — with the keys
already in the file pane, so `j` scrolls it without a keystroke of ceremony.

Four rules hold it together, and each one answers something the old
arrangement got wrong:

- **Moving the explorer's cursor reads nothing.** `j` moves a cursor over
  names; `enter` opens a tab. The preview-that-followed-the-cursor it replaces
  cost a read per keystroke, needed a debounce and a stale-read token to stay
  honest, and left you unable to scroll the file you were looking at because
  the selector lived in the other pane.
- **A tab owns its buffer.** Scroll position, in-file search, undo history and
  every unsaved edit live in the tab. Switching tabs keeps them; so does going
  to the issue list and coming back, because the workspace stays on the stack
  while something is pushed over it.
- **Editing is a mode, not a screen.** `e` turns the active tab into the
  buffer from `ui/editor.ts`, in place. `esc` goes back to reading **with the
  edits still there** — losing work takes `u` (discard this tab) or `x` (close
  it), and both ask first.
- **One commit for the whole change.** Every modified tab and every pending
  deletion goes into a single `editFiles` call.

| key          | in the explorer                  | in the file pane                |
| ------------ | -------------------------------- | ------------------------------- |
| `j` `k`      | move the cursor (reads nothing)  | scroll                          |
| `ctrl+d` `u` | page                             | page                            |
| `g` `G`      | top / bottom                     | top / bottom                    |
| `enter` `l`  | expand a directory / open a tab  | —                               |
| `h`          | collapse, or go to the parent    | scroll left (`l` scrolls right) |
| `tab`        | focus the file                   | focus the explorer              |
| `esc`        | back                             | focus the explorer              |
| `/`          | filter this level                | search in the file (`n` / `N`)  |
| `n` `D`      | new file / mark one for deletion | —                               |
| `e`          | open the file and edit it        | edit                            |
| `u`          | —                                | discard this tab's changes      |
| `v`          | —                                | the file's other view (below)   |

And the keys the whole workspace answers, from either pane: `]` `[` and `1`–`9`
move between tabs, `x` / `X` close one or the others, `c` commits, `b` lists
branches and tags, `B` creates a branch, `t` (or `ctrl+p`) is the fuzzy finder,
`y` copies the path, `i` / `p` / `C` open issues, pulls and commits, `I` shows
the about card, `W` swaps to the other side of a mirror, `O` opens the file on
its origin, `P` pins, `S` syncs, `F` forks, `,` is settings, `r` refreshes and
`E` hands the file to `$FORGE_EDITOR`.

**The tab bar.** One row above the panes: the path, the active tab bold and
underlined in the accent, `●` on anything modified, `¶` on prose being read
rather than edited, `‹ ›` when there are more tabs than fit, and the count on
the right. `¶` (U+00B6) is Latin-1, so it is in every font that can draw a box
character at all, and it is the one glyph in the safe set that already means
"formatted prose". A modified file wears the same `●` in the explorer, and one
marked for deletion is struck through in the danger colour — the same change,
said in both places. The **active** tab also wears a `✗` you can click; only
the active one, because a close box on every chip is a row of targets you hit
by accident, and the tab you mean to close is the one you are looking at.

**Two views, one key.** Some files have two honest ways of being seen, and `v`
is the toggle for all of them:

| file                | opens as             | `v` shows                |
| ------------------- | -------------------- | ------------------------ |
| `*.md`, `README*`   | rendered prose (`¶`) | the source, highlighted  |
| `*.png`, `*.jpg`, … | the picture (§6·0c)  | format · geometry · size |
| everything else     | code                 | (nothing else to show)   |

Prose opens **rendered**, because that is what a README is for and it is what
the repo card always did — but the rendered view is a view, not a mode: `j`/`k`
scroll it, `/` searches it, and `e` always edits the **source**, switching to
it if you were reading. The web and the terminal render that markdown through
the same rules, so a README reads the same in both.

**Colour follows the theme.** Switching theme re-tokenises every open tab on
the next frame; a tab that kept yesterday's palette is exactly the bug a
screenshot hides.

**Coming back is free.** A workspace's open tabs, its explorer cursor, its ref
and every uncommitted buffer live on the **session**, keyed by repository — so
popping to the dashboard and re-entering the same repo restores what you were
doing, not just where you were. One connection is one identity, so nothing
another user opened can be reached, and the memory dies with the connection;
an entry nobody has touched for thirty minutes is dropped on the next lookup.
`r` is still the refresh, and `x` still closes a tab.

**The about card (`I`).** What used to be the repo home page: visibility,
description, default branch, counts, where a mirror came from and when it was
last fetched, and the clone URLs (`y` copies one). It is a card rather than a
screen because it is something you glance at on the way to doing something
else.

The finder (`t`) scores with fzf's `--scheme=path` constants plus VS Code's
rule that any basename match outranks any directory-only match, and it says
"N files (truncated)" honestly when the listing hit its cap.

### 6c. Editing, and the commit dialog

`e` turns the active tab into a modeless editor: arrows/Home/End/PgUp/PgDn and
word jumps, shift-arrows to select, `ctrl+c`/`x`/`v` (which also mirror to
_your_ clipboard over OSC 52), `ctrl+z`/`ctrl+y`, `ctrl+f` find, `ctrl+r`
replace, horizontal scrolling with no soft wrap, tabs rendered at 4 and kept as
tabs. The status row reads `path · Ln 12, Col 4 · modified`.

Four rules are non-negotiable because this is attached to a git host: CRLF, a
BOM and the presence or absence of a trailing newline round-trip exactly;
nothing is normalised silently. Past 1 MB or 50k lines the buffer opens
read-only and says which, rather than being slow.

`c` (or `ctrl+s` from inside the buffer) opens the commit dialog. It lists
**every** change the workspace is holding — each modified tab and each pending
deletion, ticked, marked `+` added, `~` edited, `-` deleted — then asks the
three questions `editFiles` takes: message (subject, optional body), target
(`current branch` or `new branch`, defaulting to **new**, named
`<you>/edit-<file>`), and `[ ] open a pull request` with the title prefilled
from the subject. One call: no half-finished state (a branch with no commit, a
commit with no pull) can be invented. On success the workspace follows the
commit — the ref pill becomes the new branch and every tab is re-read from it.
**A refused commit keeps every buffer**, and says why on the dialog: a
protected branch, a name git will not take, an origin that said no.

Where the change has nowhere to go — a reader without write access, a live
browse of a repository nobody has offered you a route into — `e`, `c`, `n` and
`D` say so instead of opening something that could never land. Where it has a
route, they open the proposal dialog instead; §6c·1 is that route.

### 6c·1. Contributing: fork at the origin, propose a change

The workflow the origins layer exists for — _grab their repo, branch, edit,
propose it back_ — is one intention, so it is two keys and one action call
(`actions/contribute.ts`), never five screens with five half-finished states
between them.

**`F` — fork at the origin.** On a live browse (and on the picker's rows) `F`
forks at the origin rather than here: a local fork of a mirror is a copy of a
copy with nowhere to propose it back to. One confirm card, saying the whole
sentence because two machines are involved —

```
╭─ Fork at the origin ───────────────────────────────╮
│ Fork octo/widgets to your account                  │
│ at codeberg.org and mirror it here?                │
│                                                    │
│ The copy here is your workbench.                   │
│                                    Cancel  ▸ Fork  │
╰────────────────────────────────────────────────────╯
```

— then the ordinary mirror card over the job the fork started, then the fork's
own workspace. A native repository keeps the native fork. Wherever a
repository forks something at an origin, the where-strip and the about card
say so: `· fork of octo/widgets`, read from `repo.origin_fork_of` on a mirror
and from the picker's cached `fork_of` on a live browse.

**`c` — propose a change.** When the source says `permissions.push === false`
— a live browse of somebody else's repository, or a mirror whose upstream is
not ours to push to — editing is allowed and the commit dialog becomes a
proposal dialog. Same buffers, same ticked files, no "commit to `<ref>`"
option (there is no ref of theirs you may write), and a branch that lands in
your fork:

```
╭─ Propose a change ──────────────────────────── octo/widgets ─╮
│ Message                                                      │
│ Update README.md                                             │
│ optional — this becomes the pull request's body              │
│ Files · 1 of 1                                               │
│ [x] ~ README.md                                              │
│ Branch in your fork                                          │
│ alice/edit-README-md                                         │
│ Pull request › octo/widgets · main                           │
│ Update README.md                                             │
│   Propose                                                    │
╰──────────────────────────────────────────────────────────────╯
```

`contribute` does the rest in one call: fork if a fork is needed, branch from
the _upstream's_ base rather than a stale copy of it, commit into the fork,
push it there, and open the pull upstream with the `owner:branch` head form
both forges take. The toast reads `opened pull #12 on octo/widgets`, and when
we hold a mirror of that upstream the imported pull is pushed on the stack so
the reader lands on what they just proposed. **A refusal keeps every buffer**
and names which half failed — `fork_timeout`, `origin_refused`,
`mirror_failed`, an edit reason, or "the commit landed but the pull did not
open". While such a workspace is open the status row says
`proposing to octo/widgets via your fork`, on every frame, so nobody has to
press `c` to find out where their change is going.

A repository the origin says you _may_ push to keeps the ordinary commit
dialog: on a mirror that is `editFiles` plus push-through, which is
`contribute`'s own `via: "direct"` path by another name.

### 6d. `$FORGE_EDITOR` — the operator's own editor, over a pty

`E` suspends the UI and hands the terminal to `$FORGE_EDITOR` on a real pty.
**Read this before enabling it:** the editor runs on the forge host as the
forge user, and nvim's `:!sh`, `:terminal` and a sourced `init.lua` are all
arbitrary code execution. CVE-2019-12735 was RCE in Neovim from merely opening
a file with a hostile modeline, which is the exact shape of a host whose job is
displaying files other people wrote.

It is coherent under one framing only: **this is the operator's own single-user
workbench, and the editor is their shell reached through the forge.** So it is
opt-in and absent otherwise — with `FORGE_EDITOR` unset there is no spawn, no
temp file and one line of explanation; the name is resolved once with
`Bun.which` and spawned as `[bin, file]` **argv, never a shell** (a name with
whitespace in it is refused rather than tokenized); and one handoff at a time
per session, because nested suspends are the wedge behind every "my TUI hung
after I shelled out" report. Nothing in that path writes to a repository: what
comes back is spliced into the tab's own buffer — one undoable edit, and a
modified tab like any other — and reaches git only through `c` and `editFiles`,
the one way anything does. `E` is the escape hatch rather than the tool, so it
sits last in the binding list and falls off the end of the help bar.

Resume is unconditional and state-independent — the child may have crashed, so
"undo what we think it did" is exactly the reasoning that leaves a broken
terminal. Two fixes beyond re-entering the alt screen, both measured against
real nvim: `ESC[0 q` because it exits leaving a steady block and never resets
the cursor shape, and `ESC[>0u` to pop kitty keyboard flags it pushes and does
not. The input decoder is rebuilt on resume so the Primary DA reply that
arrives _after_ the child is gone lands nowhere.

**Gap:** a launch should leave an outbox event (invariant 5), and appending one
from an adapter would break the rule that only `actions/` does. It is a log
line for now; the action belongs beside `actions/contents.ts`.

### 6e. Links that work

The cell buffer has a sixth plane, `link`, holding a 1-based index into the
frame's URI table — a URL is a property of a _run of cells_ exactly like a
colour, so it diffs with one integer compare and OSC 8 falls out of the same
emit loop that already does SGR deltas. Every open carries `id=`, because a
diff renderer paints dirty runs and one logical link routinely reaches the
terminal as several disjoint spans. Links are closed **before every cursor
jump and at the end of every row**: OSC 8 and SGR are independent, so the
frame-final SGR reset does not close one.

URLs are marked in the connect screens, the repo home's clone lines, the
"page" fact and rendered markdown. And because **no control sequence exists
that means "open this in the reader's browser"** — OSC 8 marks text clickable
and the person clicks — `O`/`o` does three things at once when it cannot open
one: copies the URL through OSC 52, and pushes the **link dialog**, which
shows the address plain with **mouse reporting turned off** for as long as it
is open, so the terminal's own drag-to-select works without Shift; `c` copies
again, `enter` tries the browser, `esc` puts the mouse back. It really opens
on the local stdio session, and over SSH from this machine's own address
(`sshTerminal.local`), because then the browser is on the same screen. Four
routes to one URL (the hyperlink, the clipboard, the selectable text, the
opener), because none of them is reliable on its own.

### 6e·1. Reviews, threads, and the merge gate

A pull is judged in three places, and each says one thing.

**The verdict (`R`).** A card with three radios and an optional note —
`( ) approve  ( ) request changes  ( ) comment`, `ctrl+d` submits. Approve is
**absent** when the viewer wrote the change, because `submitReview` refuses it
(`self_review`) and a disabled control would only be a slower way to be told
no. A verdict renders in the conversation as a timeline item with a state chip
(success / danger / muted), and it is recorded against the head it was passed
on — so a push dismisses it and the item wears `before the latest push` in
muted rather than quietly still counting.

**The gate.** The merge box grows a second line saying where the verdicts
stand: `2 approvals · changes requested by bob`, and `N dismissed by a push`
when a push has cleared some. When the reviews do not let it land the box
reads `review` in `attn` and `m` says the reason out loud rather than doing
nothing:

```
╭─ Merge ──────────────────────────────────────────────────────────╮
│  review  Needs an approval of this head before it can merge      │
│ no approvals yet                                                 │
╰────────────────────────────────────── fix › main · 1 file +1 -1 ─╯
```

That is a rendering of `reviewGate` (`core/pulls.ts`) and nothing more: an
outstanding request for changes blocks whatever the setting says, and
`require a review before merging` (repo settings, `R`) additionally demands an
approval of the current head. The refusal is mechanical in `mergePull`, which
reads the gate from the live head — a check computed earlier and handed down
is a check that can be skipped.

**Threads.** Review comments sharing one anchor are one conversation. In the
files tab the section header reads `3 threads · 1 unresolved`; `x` settles or
reopens the thread the cursor is standing on (a writer, or whoever raised it);
`n`/`p` walk the unsettled ones while the cursor is inside one, and go back to
walking hunks when it is not. A settled thread collapses to a single dim line
— `✓ resolved by alice · 2h · enter to expand` — because the point of settling
something is to stop looking at it, and `enter` opens the record back up
because the point of a record is that it is still there. Standing on the diff
line a thread hangs from counts as standing on the thread: that is what a
reader means by "this one".

A pull list row wears the same verdict in one tabular column — `✓` approved,
`✗` changes requested, `·` nobody has looked — read for the whole page in one
grouped query, never one per row.

### 6f. Realtime

Dashboard, issue and pull lists, the repo home, and the issue and pull screens
all subscribe to the outbox for as long as they are on the stack, through one
helper (`live()` in `screens/common.ts`). Popping the screen unsubscribes it —
there is no lifecycle to get wrong. A burst is coalesced into one refresh.

---

### 6g. Apps, runs and the crew, where the terminal still shows them

The terminal's half of §5c is deliberately small: running an app and
managing the crew are the studio's (`docs/STUDIO.md`), and the terminal has
no apps, app, runs, run or crew screen and no palette entry for one. What
remains is where the work is reviewed:

- **Pull** — a preview line when the repository is an app (`O` opens it,
  `P` opens production beside it: comparing the two is the review), a
  checks row in the merge box and a _waiting on checks_ state with the refusal
  in words on `m`, `a` to assign (nobody, people, then the crew with the bot
  glyph on a Nerd Font), and a Crew tab of the agent runs about it.
- **`T` on a pull's preview** suspends the UI and runs the app's `tty` on
  the same pty — one connection, two programs in turn, exactly as
  `$FORGE_EDITOR` runs — and the UI returns when it exits. Every refusal
  (not running, no `tty`, private to a guest) is a toast in the same words
  the ssh front door uses.
- **Issue** — `a` to assign; a Crew card when an agent has runs, `tab` moves
  focus to it.
- **A run** is a row (`screens/runlist.ts`): state dot and word, who, why,
  the summary. `enter` on one hands over its web page,
  `/:owner/:name/runs/:id`, where the live log, cancel and steer are — as a
  link when the forge knows its public URL, as the path otherwise.
- **Settings** — the App tab (enable with slug, access and preview data; edit;
  `D` to stop running as an app behind a confirm), `C` for require checks on
  General, the Crew tab (`a` adds an agent from the forge's, `d` removes).

A guest is told so in words; nothing here is a way around the actions'
answers.

## 7. Two rules that are security boundaries

**Label colors.** Inline `style=""` is blocked by the CSP — nonces apply to
elements, not attributes. A page therefore collects the label colors it will
render and emits one nonce'd rule per color:

```css
.lc-d73a4a {
  --label: #d73a4a;
}
```

and the static sheet derives the chip from it with `color-mix`, so one stored
hex reads correctly in all six themes. `labelCss()` re-validates
`/^[0-9a-f]{6}$/` immediately before embedding. That check is the boundary —
treat it like `assertBatchSafe`, not like a nicety.

**The confirm page.** Every destructive button is a link to `/-/confirm?to=…`.
That page derives its own title, detail and typed-phrase requirement from a
table of known destructive routes, and 404s on anything else. The wording never
comes from the link, so a mailed URL cannot put "Continue" on a button that
deletes a repository.

---

## 8. Checklist before you call a screen done

1. Every divider is exactly 1px. The only 2px things are the active-tab
   underline and the focus ring.
2. Every number that lines up is tabular.
3. Icons sit in a fixed 16px slot; the text baseline does not move when one
   appears.
4. Secondary actions are in the DOM at `opacity: 0` and revealed on hover —
   never `display: none` → `flex`. A settings row is the exception: its
   control is the point of the row, so it sits in `.row-fields`, visible at
   rest, and the list wears `.setting-list` (see §5d).
5. Exactly one accent-colored thing, and it is the action.
6. The empty state has exactly one button.
7. Nothing on the page needs JavaScript to work.
8. It survives 200% zoom and a 320px viewport with no horizontal body scroll —
   diffs and code scroll inside their own card.
9. Nothing inside a linked row is itself a link.
10. Any control that only works with a script carries `js-only`, so a page
    without JavaScript never shows a dead button.
11. Every token count sits beside a byte size, a cost or a percentage, and
    goes through `tokenCount()` — never a hand-written `k`.
