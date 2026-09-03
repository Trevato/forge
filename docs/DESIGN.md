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
| `--tok-*`                        | syntax. Eight classes, no more.                                                                                         |
| `--shadow-1` / `--shadow-2`      | a hint and an overlay. Near-transparent in dark palettes, so one rule serves every theme.                               |

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

| component                                     | web class                                                                                  | variants (`data-*`)                                                                                                                      | states                                                                                                                                                                                                            | terminal equivalent                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------ |
| **button** `btn()`                            | `.btn`                                                                                     | `variant=primary\|secondary\|outline\|ghost\|danger\|link`, `size=sm\|lg`                                                                | hover, active, `:focus-visible`, `[disabled]`, `[aria-busy]`                                                                                                                                                      | a labelled key or a highlighted action cell                        |
| **icon button** `iconBtn()`                   | `.btn.btn-icon`                                                                            | same                                                                                                                                     | `aria-label` required                                                                                                                                                                                             | a single glyph with a status-bar hint                              |
| **input / textarea / select** `field()`       | `.input`                                                                                   | `size=sm`, `[aria-invalid]`                                                                                                              | focus, `:user-invalid`, `[readonly]`                                                                                                                                                                              | a line editor with an inline error row                             |
| **form field** `field()`                      | `.field` (`label`, `.hint`, `.error`)                                                      | `data-invalid`                                                                                                                           | —                                                                                                                                                                                                                 | label line, value line, hint line                                  |
| **checkbox**                                  | `.check`                                                                                   | —                                                                                                                                        | native, `accent-color` themed                                                                                                                                                                                     | `[x]` / `[ ]`                                                      |
| **badge** `badge()` / `stateBadge()`          | `.badge`                                                                                   | `variant=secondary\|outline\|success\|danger\|merged\|attn`; `data-state=open\|closed`, `data-pr=merged`                                 | —                                                                                                                                                                                                                 | a bracketed word in the state color                                |
| **label chip** `labelChip()`                  | `.label`                                                                                   | color via `--label` (see §7)                                                                                                             | —                                                                                                                                                                                                                 | a colored `‹name›`                                                 |
| **author** `userLink()` / `userTag()`         | `.byline` (`.byline-name`)                                                                 | —                                                                                                                                        | `userTag` inside anything already a link — see below                                                                                                                                                              | `@name` in the avatar hue                                          |
| **avatar** `avatar()`                         | `.avatar`                                                                                  | `size=md\|lg`, `data-h=0..11`                                                                                                            | initials, deterministic hue                                                                                                                                                                                       | two initial letters in the same hue                                |
| **count**                                     | `.count`                                                                                   | —                                                                                                                                        | glyph plus a tabular number                                                                                                                                                                                       | `⌸ 3`                                                              |
| **stat pill** `pill()`                        | `.pill`                                                                                    | `data-tone=accent\|danger`                                                                                                               | tabular                                                                                                                                                                                                           | a parenthesised count                                              |
| **status dot** `dot()`                        | `.dot`                                                                                     | `data-tone=success\|danger\|attn\|merged`                                                                                                | —                                                                                                                                                                                                                 | `●` in the tone                                                    |
| **sha** `sha()`                               | `.sha`                                                                                     | —                                                                                                                                        | first 7 chars                                                                                                                                                                                                     | the same 7 chars, dim                                              |
| **kbd** `kbd()`                               | `kbd`                                                                                      | —                                                                                                                                        | —                                                                                                                                                                                                                 | a reverse-video key name                                           |
| **card** `card()` / `listCard()`              | `.card` (`.card-head`, `.card-body`, `.card-foot`)                                         | `data-tone=success\|danger\|merged\|attn`                                                                                                | —                                                                                                                                                                                                                 | a box with a title bar                                             |
| **list row** `row()`                          | `.row` (`.row-lead`, `.row-main`, `.row-title`, `.row-meta`, `.row-trail`, `.row-actions`) | `data-state=open\|closed\|merged\|draft` — colours the **lead glyph**, so a list filtered by state carries no badge repeating the filter | hover, focus, `data-nav`; `.row-meta` is one honest line: nowrap, ellipsis, `title`                                                                                                                               | one line: glyph, title, right-aligned meta                         |
| **edit row**                                  | `.edit-row`                                                                                | —                                                                                                                                        | one line on a desktop, stacked below 720px                                                                                                                                                                        | a form line                                                        |
| **colour field**                              | `.color-field`                                                                             | —                                                                                                                                        | native `<input type=color>` plus its hex; works with no script                                                                                                                                                    | a hex entry                                                        |
| **table**                                     | `.table`                                                                                   | `data-dense`                                                                                                                             | —                                                                                                                                                                                                                 | aligned columns                                                    |
| **tabs** `tabs()`                             | `.tabs > a`                                                                                | —                                                                                                                                        | `aria-current="page"` + 2px `--fg` underline                                                                                                                                                                      | a header row with the active item underlined                       |
| **segmented control** `seg()`                 | `.seg > a`                                                                                 | —                                                                                                                                        | `aria-current`, or `:has(:checked)` for radios                                                                                                                                                                    | `‹ Open                                                            | Closed | All ›` |
| **menu** `menu()`                             | `.menu` (`<details>`)                                                                      | `data-align=start\|end`                                                                                                                  | open/closed                                                                                                                                                                                                       | a popup list                                                       |
| **dialog**                                    | `.dialog`                                                                                  | `data-side=bottom` (sheet)                                                                                                               | JS `showModal()`; every dialog has a real page behind it                                                                                                                                                          | a modal box                                                        |
| **tooltip**                                   | `[data-tip]`                                                                               | `data-tip-side=bottom`                                                                                                                   | hover/focus; hidden on coarse pointers                                                                                                                                                                            | a status-bar hint                                                  |
| **toast / flash** `Flash`                     | `.toast`                                                                                   | `data-tone=success\|danger\|attn`                                                                                                        | one per page load, cookie-driven                                                                                                                                                                                  | a one-line banner                                                  |
| **command palette**                           | `.palette`                                                                                 | —                                                                                                                                        | JS only; degrades to `/search`                                                                                                                                                                                    | a fuzzy-find overlay                                               |
| **breadcrumb** `crumbs()`                     | `.crumbs`                                                                                  | `.mono`                                                                                                                                  | `aria-current` on the last                                                                                                                                                                                        | `a / b / c`                                                        |
| **pagination** `pager()`                      | `.pager`                                                                                   | —                                                                                                                                        | cursor links, absent ends                                                                                                                                                                                         | `‹ Newer  Page 2  Older ›`                                         |
| **timeline item** `tlEvent()` / `tlComment()` | `.tl-item`                                                                                 | `data-kind=comment\|event`, `data-tone`                                                                                                  | —                                                                                                                                                                                                                 | a card, or one dim line with a glyph                               |
| **empty state** `empty()`                     | `.card.empty`                                                                              | —                                                                                                                                        | icon, one title, one sentence, **exactly one** action                                                                                                                                                             | the same three lines, centered                                     |
| **diff file**                                 | `.diff-file`                                                                               | `data-status`, `<details open>`, `.diff-viewed`                                                                                          | collapsed, viewed                                                                                                                                                                                                 | a foldable file section                                            |
| **code block**                                | `.code`                                                                                    | `:target` / `[data-hl]` line highlight                                                                                                   | —                                                                                                                                                                                                                 | a numbered gutter                                                  |
| **prose**                                     | `.prose`                                                                                   | —                                                                                                                                        | 15px, 72ch measure                                                                                                                                                                                                | wrapped markdown                                                   |
| **settings shell** `settingsLayout()`         | `.settings` (`.settings-nav`, `.settings-main`)                                            | —                                                                                                                                        | sticky nav ≥860px, scroll strip below                                                                                                                                                                             | a sidebar and a pane                                               |
| **repo header** `repoHeader()`                | `.repo-head`                                                                               | —                                                                                                                                        | tab counts, Settings only for admins                                                                                                                                                                              | a title line and a tab row                                         |
| **where strip** `whereStrip()` (`scope.ts`)   | `.where > .where-place`                                                                    | `data-state=reading\|present\|absent` — accent dot, success dot, faint dot                                                               | three places, always in this order and these words; a place is a link where one exists, and the third is the pin toggle                                                                                           | `● codeberg.org · ● workbench · ◆ this machine`                    |
| **live-browse banner** `liveBanner()`         | `.live-note`                                                                               | —                                                                                                                                        | only on a live browse, above the content, one sentence                                                                                                                                                            | one accent line under the tab row                                  |
| **where-it-lives block**                      | `.where-block`                                                                             | —                                                                                                                                        | origin, last fetch, Sync now and where pushes land, as one block in the About rail                                                                                                                                | the same four lines under a rule                                   |
| **mirror stages** `stageList()`               | `.stages > li`                                                                             | `data-state=done\|now\|failed\|todo`                                                                                                     | the stage order is the markup order; a script updates it in place and a `<meta refresh>` does it without one                                                                                                      | a checklist with `●`/`◐`/`○`                                       |
| **origin chip** (`chrome.ts`)                 | `.repo-origin > .origin-chip`                                                              | the forge's mark: `github` / `forgejo` / `gitea`                                                                                         | the older one-line form, still used off the repo header                                                                                                                                                           | one `mirrored from owner/name @ host` fact line                    |
| **origin state badge** `badge()`              | `.badge`                                                                                   | `success` healthy · `danger` needs re-auth · `attn` error                                                                                | the error message sits under the row, never inside the badge                                                                                                                                                      | the same three words beside the row                                |
| **imported author** `originTag()`             | `.byline.origin-by`                                                                        | the origin's mark instead of an avatar                                                                                                   | never a link to `/name` — that would be a different person                                                                                                                                                        | `▲ login`                                                          |
| **pin toggle** `whereRow()`                   | `.repo-where form.where-pin > .btn`                                                        | `outline` unpinned · `secondary` pinned                                                                                                  | reads `Keep on my machine` / `On my machine ◆`; the strip's third place submits the same form by id, so a `<button>` can sit in a row of links; the wanted state rides the form, so a double submit is idempotent | `p` on a row, `P` on a repo home; `◆` marks a pinned row           |
| **device code**                               | `.device-code`                                                                             | —                                                                                                                                        | the one deliberately large type in the product: monospace, tabular, `user-select: all`                                                                                                                            | the code spaced out and centred in a card, with a spinner under it |
| **sticky action** `stickyAction()`            | `.sticky-action`                                                                           | —                                                                                                                                        | static ≥720px                                                                                                                                                                                                     | a footer action bar                                                |
| **count group** `counts()` / `repoCounts()`   | `.counts > .count`                                                                         | —                                                                                                        | icon plus a tabular number; **a zero is never drawn** — the absence is the same information | `⊙3 ⑂1` after the row title |
| **file explorer** `explorerColumn()`          | `.code-layout` (`.explorer-panel`, `.explorer`, `.ex-dir`, `.ex-file`, `.ex-more`)         | —                                                                                                        | the path's ancestors arrive `open`; the current file is `aria-current`; a folder off the spine holds one `.ex-more` link so it works with no script | a left pane the cursor walks |
| **fuzzy finder** `finderDialog()`             | `.dialog.palette.finder`                                                                   | —                                                                                                        | JS only; `t` opens it, the explorer beside it is the fallback | the file picker overlay                      |
| **file editor**                               | `.editor-form` (`.editor-head`, `.editor-wrap`, `textarea.editor`, `.editor-gutter`, `.editor-commit`) | —                                                                                              | a plain `<textarea>` in a `<form>`; the gutter, tab key, auto-indent and Preview tab are all enhancement | a modal buffer with a commit prompt |
| **branch row**                                | `.branch-row` (`.branch-div` → `.ahead` / `.behind`)                                       | —                                                                                                        | default first, `Default` and `Protected` badges, `↑ahead ↓behind` | one line per branch with the same arrows |
| **code hit**                                  | `.code-hit` (`.code-line`, `mark`)                                                         | —                                                                                                        | `path:line` in mono, the matching line beneath it with the query marked | the same two lines, the match reversed |

Two things are deliberately **not** in the vocabulary: skeleton loaders (the
server renders whole pages — there is nothing to skeletonise) and a custom
switch control (a native checkbox with `accent-color` is themed, keyboard-correct
and honest about what it is).

Three rules the browser enforces whether or not you meant them:

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
- A live browse also carries `.live-note` above the content, saying it is
  read-only and what to do about that. There is no second way to find out: a
  live page renders no composer, no state form, no labels form, no merge box
  and no settings tab, because `RepoSource` has no mutation on it to submit to.

The strip is the visible half of `RepoScope` (`src/web/scope.ts`); the pages it
sits on are the same renderers for both sides of the world, and a divergence
between a live browse and the repository we hold would be a bug you could see.

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
  *prefix* outranks that again. Without a script the finder does not exist and
  the explorer beside it is the answer.

### 6b. The editor

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

**Terminal keys and glyphs for origins.** Account → `o` opens Origins; there
`c` connects, `s` syncs now, `r` browses the origin's repositories and `D`
disconnects. In the picker `enter` **browses** the row — live, read-only,
nothing downloaded — and `m` mirrors it into the workbench; a second `m` on a
running mirror joins the job rather than starting a second one. On a repo's
home `y` syncs the mirror and `P` pins it — `p` has meant _pulls_ on that
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

### 6b. Browsing code

The tree and the blob are one screen, not a stack. At **≥100 columns** it is
two panes — the explorer on the left, the file under the cursor on the right,
loading as the cursor moves; below 100 it is one pane and `tab`/`esc` swap
which. The breadcrumb above both is always `owner/name › ref › path`.

| key          | in the explorer                     | in the file pane               |
| ------------ | ----------------------------------- | ------------------------------ |
| `j` `k`      | move (the preview follows)          | scroll                         |
| `ctrl+d` `u` | page                                | page                           |
| `g` `G`      | top / bottom                        | top / bottom                   |
| `l` `enter`  | expand a directory / focus the file | —                              |
| `h`          | collapse, or go to the parent       | —                              |
| `tab`        | focus the file                      | focus the explorer             |
| `esc`        | back                                | focus the explorer             |
| `/`          | filter this level                   | search in the file (`n` / `N`) |
| `t` `ctrl+p` | the fuzzy file finder               | the fuzzy file finder          |
| `e`          | edit                                | edit                           |
| `E`          | `$FORGE_EDITOR` over a pty          | same                           |
| `n` `D`      | new file / delete a file            | —                              |
| `y`          | copy the path                       | copy the path                  |
| `b`          | switch ref                          | switch ref                     |
| `W`          | the other side (local ↔ origin)     | same                           |
| `O`          | open on the origin                  | same                           |

Moving the cursor **schedules** a read 60ms out rather than firing one; every
read carries a token and a stale one is dropped, so a slow origin answering
for a file you have moved off cannot paint over the file you are looking at.
The finder scores with fzf's `--scheme=path` constants plus VS Code's rule
that any basename match outranks any directory-only match, and it says
"N files (truncated)" honestly when the listing hit its cap.

### 6c. Editing, and the commit dialog

`e` opens a modeless editor: arrows/Home/End/PgUp/PgDn and word jumps,
shift-arrows to select, `ctrl+c`/`x`/`v` (which also mirror to _your_
clipboard over OSC 52), `ctrl+z`/`ctrl+y`, `ctrl+f` find, `ctrl+r` replace,
horizontal scrolling with no soft wrap, tabs rendered at 4 and kept as tabs.
The status line is `path · Ln 12, Col 4 · modified`.

Four rules are non-negotiable because this is attached to a git host: CRLF, a
BOM and the presence or absence of a trailing newline round-trip exactly;
nothing is normalised silently. Past 1 MB or 50k lines the buffer opens
read-only and says which, rather than being slow.

`ctrl+s` opens the commit dialog — message (subject, optional body), target
(`current branch` or `new branch`, defaulting to **new**, named
`<you>/edit-<file>`), and `[ ] open a pull request` with the title prefilled
from the subject. It calls `editFiles` once: that is the whole edit, so no
half-finished state (a branch with no commit, a commit with no pull) can be
invented. `esc` with unsaved changes asks first.

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
after I shelled out" report. Nothing in that path writes to a repository: the
bytes come back through the commit dialog and reach git the one way anything
does.

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
and the person clicks — `O`/`o` over SSH copies the URL through OSC 52 and
says `copied — cmd-click the link to open it`, rather than the old, true and
useless "no browser available". On the local stdio session it really opens.
Three routes to one URL (the hyperlink, the clipboard, the visible text),
because none of them is reliable on its own.

### 6f. Realtime

Dashboard, issue and pull lists, the repo home, and the issue and pull screens
all subscribe to the outbox for as long as they are on the stack, through one
helper (`live()` in `screens/common.ts`). Popping the screen unsubscribes it —
there is no lifecycle to get wrong. A burst is coalesced into one refresh.

---

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
   never `display: none` → `flex`.
5. Exactly one accent-colored thing, and it is the action.
6. The empty state has exactly one button.
7. Nothing on the page needs JavaScript to work.
8. It survives 200% zoom and a 320px viewport with no horizontal body scroll —
   diffs and code scroll inside their own card.
9. Nothing inside a linked row is itself a link.
10. Any control that only works with a script carries `js-only`, so a page
    without JavaScript never shows a dead button.
