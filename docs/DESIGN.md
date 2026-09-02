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

| component                                     | web class                                                                                  | variants (`data-*`)                                                                                      | states                                                       | terminal equivalent                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------- | ------ | ------ |
| **button** `btn()`                            | `.btn`                                                                                     | `variant=primary\|secondary\|outline\|ghost\|danger\|link`, `size=sm\|lg`                                | hover, active, `:focus-visible`, `[disabled]`, `[aria-busy]` | a labelled key or a highlighted action cell  |
| **icon button** `iconBtn()`                   | `.btn.btn-icon`                                                                            | same                                                                                                     | `aria-label` required                                        | a single glyph with a status-bar hint        |
| **input / textarea / select** `field()`       | `.input`                                                                                   | `size=sm`, `[aria-invalid]`                                                                              | focus, `:user-invalid`, `[readonly]`                         | a line editor with an inline error row       |
| **form field** `field()`                      | `.field` (`label`, `.hint`, `.error`)                                                      | `data-invalid`                                                                                           | —                                                            | label line, value line, hint line            |
| **checkbox**                                  | `.check`                                                                                   | —                                                                                                        | native, `accent-color` themed                                | `[x]` / `[ ]`                                |
| **badge** `badge()` / `stateBadge()`          | `.badge`                                                                                   | `variant=secondary\|outline\|success\|danger\|merged\|attn`; `data-state=open\|closed`, `data-pr=merged` | —                                                            | a bracketed word in the state color          |
| **label chip** `labelChip()`                  | `.label`                                                                                   | color via `--label` (see §7)                                                                             | —                                                            | a colored `‹name›`                           |
| **author** `userLink()` / `userTag()`         | `.byline` (`.byline-name`)                                                                 | —                                                                                                        | `userTag` inside anything already a link — see below                                            | `@name` in the avatar hue                    |
| **avatar** `avatar()`                         | `.avatar`                                                                                  | `size=md\|lg`, `data-h=0..11`                                                                            | initials, deterministic hue                                  | two initial letters in the same hue          |
| **count**                                     | `.count`                                                                                   | —                                                                                                        | glyph plus a tabular number                                                                  | `⌸ 3`                                        |
| **stat pill** `pill()`                        | `.pill`                                                                                    | `data-tone=accent\|danger`                                                                               | tabular                                                      | a parenthesised count                        |
| **status dot** `dot()`                        | `.dot`                                                                                     | `data-tone=success\|danger\|attn\|merged`                                                                | —                                                            | `●` in the tone                              |
| **sha** `sha()`                               | `.sha`                                                                                     | —                                                                                                        | first 7 chars                                                | the same 7 chars, dim                        |
| **kbd** `kbd()`                               | `kbd`                                                                                      | —                                                                                                        | —                                                            | a reverse-video key name                     |
| **card** `card()` / `listCard()`              | `.card` (`.card-head`, `.card-body`, `.card-foot`)                                         | `data-tone=success\|danger\|merged\|attn`                                                                | —                                                            | a box with a title bar                       |
| **list row** `row()`                          | `.row` (`.row-lead`, `.row-main`, `.row-title`, `.row-meta`, `.row-trail`, `.row-actions`) | `data-state=open\|closed\|merged\|draft` — colours the **lead glyph**, so a list filtered by state carries no badge repeating the filter | hover, focus, `data-nav`; `.row-meta` is one honest line: nowrap, ellipsis, `title`           | one line: glyph, title, right-aligned meta   |
| **edit row**                                  | `.edit-row`                                                                                | —                                                                                                        | one line on a desktop, stacked below 720px                                                   | a form line                                  |
| **colour field**                              | `.color-field`                                                                             | —                                                                                                        | native `<input type=color>` plus its hex; works with no script                               | a hex entry                                  |
| **table**                                     | `.table`                                                                                   | `data-dense`                                                                                             | —                                                            | aligned columns                              |
| **tabs** `tabs()`                             | `.tabs > a`                                                                                | —                                                                                                        | `aria-current="page"` + 2px `--fg` underline                 | a header row with the active item underlined |
| **segmented control** `seg()`                 | `.seg > a`                                                                                 | —                                                                                                        | `aria-current`, or `:has(:checked)` for radios               | `‹ Open                                      | Closed | All ›` |
| **menu** `menu()`                             | `.menu` (`<details>`)                                                                      | `data-align=start\|end`                                                                                  | open/closed                                                  | a popup list                                 |
| **dialog**                                    | `.dialog`                                                                                  | `data-side=bottom` (sheet)                                                                               | JS `showModal()`; every dialog has a real page behind it     | a modal box                                  |
| **tooltip**                                   | `[data-tip]`                                                                               | `data-tip-side=bottom`                                                                                   | hover/focus; hidden on coarse pointers                       | a status-bar hint                            |
| **toast / flash** `Flash`                     | `.toast`                                                                                   | `data-tone=success\|danger\|attn`                                                                        | one per page load, cookie-driven                             | a one-line banner                            |
| **command palette**                           | `.palette`                                                                                 | —                                                                                                        | JS only; degrades to `/search`                               | a fuzzy-find overlay                         |
| **breadcrumb** `crumbs()`                     | `.crumbs`                                                                                  | `.mono`                                                                                                  | `aria-current` on the last                                   | `a / b / c`                                  |
| **pagination** `pager()`                      | `.pager`                                                                                   | —                                                                                                        | cursor links, absent ends                                    | `‹ Newer  Page 2  Older ›`                   |
| **timeline item** `tlEvent()` / `tlComment()` | `.tl-item`                                                                                 | `data-kind=comment\|event`, `data-tone`                                                                  | —                                                            | a card, or one dim line with a glyph         |
| **empty state** `empty()`                     | `.card.empty`                                                                              | —                                                                                                        | icon, one title, one sentence, **exactly one** action        | the same three lines, centered               |
| **diff file**                                 | `.diff-file`                                                                               | `data-status`, `<details open>`, `.diff-viewed`                                                          | collapsed, viewed                                            | a foldable file section                      |
| **code block**                                | `.code`                                                                                    | `:target` / `[data-hl]` line highlight                                                                   | —                                                            | a numbered gutter                            |
| **prose**                                     | `.prose`                                                                                   | —                                                                                                        | 15px, 72ch measure                                           | wrapped markdown                             |
| **settings shell** `settingsLayout()`         | `.settings` (`.settings-nav`, `.settings-main`)                                            | —                                                                                                        | sticky nav ≥860px, scroll strip below                        | a sidebar and a pane                         |
| **repo header** `repoHeader()`                | `.repo-head`                                                                               | —                                                                                                        | tab counts, Settings only for admins                         | a title line and a tab row                   |
| **origin chip** (`chrome.ts`)                 | `.repo-origin > .origin-chip`                                                              | the forge's mark: `github` / `forgejo` / `gitea`                                                         | links to the repo at its origin; a plain span when it has no URL | one `mirrored from owner/name @ host` fact line |
| **origin state badge** `badge()`              | `.badge`                                                                                   | `success` healthy · `danger` needs re-auth · `attn` error                                                | the error message sits under the row, never inside the badge | the same three words beside the row          |
| **imported author** `originTag()`             | `.byline.origin-by`                                                                        | the origin's mark instead of an avatar                                                                   | never a link to `/name` — that would be a different person   | `▲ login`                                    |
| **pin toggle** `iconBtn("pin"\|"pinOff")`     | `.repo-origin form > .btn.btn-icon`                                                        | `ghost` unpinned · `secondary` pinned                                                                    | the wanted state rides the form, so a double submit is idempotent | `p` on a row, `P` on a repo home; `◆` marks a pinned row |
| **device code**                               | `.device-code`                                                                             | —                                                                                                        | the one deliberately large type in the product: monospace, tabular, `user-select: all` | the code spaced out and centred in a card, with a spinner under it |
| **sticky action** `stickyAction()`            | `.sticky-action`                                                                           | —                                                                                                        | static ≥720px                                                | a footer action bar                          |

Two things are deliberately **not** in the vocabulary: skeleton loaders (the
server renders whole pages — there is nothing to skeletonise) and a custom
switch control (a native checkbox with `accent-color` is themed, keyboard-correct
and honest about what it is).

Three rules the browser enforces whether or not you meant them:

- **A link inside a link is not a link.** `<a>` nested in `<a>` is not merely
  invalid — the parser closes the outer anchor and re-parents everything after
  it as a *sibling*, so the row visibly falls apart. Anything rendered inside a
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
| `g s`           | repo settings                                  |
| `j` / `k`       | next / previous row (visible focus ring)       |
| `o` or `Enter`  | open the focused row                           |
| `c`             | the page's create action (new issue, new pull) |
| `/`             | focus search                                   |
| `⌘K` / `Ctrl K` | command palette                                |
| `?`             | shortcut help                                  |
| `Esc`           | close a menu or dialog, blur a field           |

Inside the code view, shift-clicking a second line number extends `#L3` to
`#L3-L9` and highlights the range.

**Terminal keys and glyphs for origins.** Account → `o` opens Origins; there
`c` connects, `s` syncs now, `r` lists the origin's repositories and `D`
disconnects. In the picker `enter` or `m` mirrors the row. On a repo's home
`y` syncs the mirror and `P` pins it — `p` has meant *pulls* on that screen
since before pins existed, so the toggle takes the shifted key there and the
plain `p` everywhere a repo is a *row* (the dashboard, explore).

Two glyphs carry this, both from the safe set in `term/screen.ts`:

| glyph | means                                                       |
| ----- | ----------------------------------------------------------- |
| `▲`   | this came from the origin — an imported author or activity  |
| `◆`   | kept on your machine (pinned)                               |

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
