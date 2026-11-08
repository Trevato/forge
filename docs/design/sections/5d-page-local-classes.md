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

- **`style/base.ts`** — the page shell (topbar, main, footer) and the layout and text utilities every page leans on (all of them now named in docs/design/areas/shell.md and visibility.md).
- **`style/components.ts`** — parts of the §5 components that the table does not spell out — the palette's list, the menu's items, a dialog's head and foot, comments — and a few small helpers beside them:
- **`style/content.ts`, page furniture** — what frames a page's content: repo heads, the front page and its tiles, explore, backups, boards, the fleet chart's series colours, lineage:
  - `.repo-actions`
- **`style/content.ts`, apps, runs, and the crew** — run pages, their logs and checks (a pull's look is §5's **look**).
- **`pages/board.ts`** — the board itself is §5's **board**; the spend tables `spend.ts` draws wear §5's `.table` and `.stack`, no class of their own
- **`studio/feed_style.ts`** — the home feed's cards and its composer (the apps rail is §5's card, row and btn; an admin's tick boxes and Archive are always shown, deliberately, with no Select toggle):
