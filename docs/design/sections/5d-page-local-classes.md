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
  - `.hide-sm`
  - `.js-only`
  - `.reduced`
  - `.shell`
  - `.skip`
  - `.topbar`
  - `.wordmark`

  A `.field` directly inside a `.bar` drops its bottom margin and the bar aligns to the end, so a labelled input and its button share a baseline
- **`style/components.ts`** — parts of the §5 components that the table does not spell out — the palette's list, the menu's items, a dialog's head and foot, comments, the theme picker — and a few small helpers beside them:
  - `.cat`
  - `.error-note`
  - `.list`
  - `.menu-item`
  - `.preview`
  - `.sep`
  - `.split`
  - `.swatch`

  `.split` is the one two-column page: main, then an `<aside>` rail of 260px that sticks from 960px. `data-rail="wide"` on it (the studio's home and an app's page) widens the rail to 320px from 900px, drops the top margin, and lets the rail scroll with the page, since a column of cards runs taller than a screen
- **`style/content.ts`, page furniture** — what frames a page's content: page and repo heads, the front page and its tiles, explore, backups, boards, the fleet chart's series colours, lineage:
  - `.bgrid`
  - `.bp-h2`
  - `.bp-h3`
  - `.bp-w2`
  - `.bp-w3`
  - `.commit-body`
  - `.commit-head`
  - `.filters`
  - `.front-admin`
  - `.front-pick`
  - `.owner`
  - `.page-head`
  - `.policy-line`
  - `.repo-actions`
  - `.repo-desc`
  - `.repo-title`
  - `.slash`
- **`style/content.ts`, apps, runs, and the crew** — run pages, their logs and checks (a pull's look is §5's **look**).
- **`pages/board.ts`** — the board itself is §5's **board**; the spend tables `spend.ts` draws wear §5's `.table` and `.stack`, no class of their own
- **`studio/feed_style.ts`** — the home feed's cards and its composer (the apps rail is §5's card, row and btn; an admin's tick boxes and Archive are always shown, deliberately, with no Select toggle):
