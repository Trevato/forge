# DESIGN.md — the forge's design system

**The principles, in short.** (The numbered list in §1 is the long form.)

1. One confident sentence says what the page is for; nothing explains itself twice.
2. The real product is the visual: show the actual rows, not a picture of them.
3. Generous rhythm: space between things, not lines.
4. One background, one text colour (`--bg`, `--fg`), muted for the rest.
5. At most one accent, `--accent`, for interaction alone. Enforced: `accent` in `scripts/design-lint.ts`.
6. Few borders: a hairline where a thing ends, never a box around a thing.
7. Rows over boxes: a list is rows, a fact is a `dl` row, not a card.
8. Plain words, as in `docs/WRITING.md`.

**The first five minutes.** Later work is judged against this one journey, a stranger's from a link to a change live:
1. They follow a link. 2. They name the forge. 3. They choose a username and password. 4. They say what to build. 5. They see the crew working.

Budgets: at most three screens before the forge; the forge ready in under 20 s; the first crew activity in under 60 s; the change live within five minutes.

Words a stranger is never shown on this path: subscription, autonomy, cell, child, claim. The list lives once, as `STRANGER_NEVER_SEES` in `src/design/first_five_minutes.ts` (with the budgets), for a test to import.

**The five rules of attention.** Every pass over a page follows them; the owner's time is the cost.
Each has a real page as its pair. Enforced by rule 5: `test/attention.test.ts`.

1. **One answer.** A page answers its one question at first sight. State is a word and a glyph, not a sentence.
   - Do: `securityPage` gives each fact a toned `badge` (Recent, Overdue), not a paragraph.
   - Don't: `previewSection` (`src/web/pages/apps.ts`) says "The last deploy of this preview failed. Push again to redeploy it." where `Failed` with the tone says it.
2. **No notes.** Explanatory prose that does not change a decision goes. Help lives in one place, on demand.
   - Do: the home composer is the sentence of purpose and the control itself (`studioHome`).
   - Don't: a `<p class="muted small">` under a list that explains what the list is; the heading already did.
3. **Real depth only.** Details, history, logs and evidence open in place, in their own compartment. The essential is never one tap away, and nothing is a tap with nothing behind it.
   - Do: the `disclosure` in `src/web/ui.ts` (used in `src/web/pages/new-forge.ts`) holds the optional extras; the choice stays on the page.
   - Don't: a disclosure that opens onto one line, or one that hides the verdict.
4. **Compartments.** Each concern sits in one region with one heading, in the same order on every page. Regions never repeat each other.
   - Do: `/settings`, where each concern is one `settings-block` with one heading.
   - Don't: the same fact in the header, the tab count and a status line, as the Pulls tab and its list once did (#10312).
5. **Measured.** Every page has a first-view budget at a narrow (390 px) and a wide (1280 px) width: visible words, text blocks and distinct colours, in `docs/design/attention-budget.json`. A page over its budget fails `test/attention.test.ts`. A pass may lower a budget; raising one needs a note in the pull. See `docs/features/attention.md`.

**Worked examples.**
- `src/web/studio/home.ts`, `studioHome`: the `<h1 class="sr-only">Home</h1>` then `tellBox` is
  one sentence of purpose (1) and the real composer, not a picture of one (2); `<section class="stack">`
  gives the rhythm (3); the lines `<p class="small muted"><a href="/feed">The feed</a></p>` are
  muted text, not buttons or boxes (4, 7).
- `src/web/pages/security.ts`, `securityPage`: `<dl class="status-rows">` with one `statusRow`
  per fact (Traffic, Backup, Admin accounts, …) is rows over boxes (7); a row that leads
  anywhere ends in one `<a>` (Traffic, Backups), the only interactive colour (5); each row says
  its state in a few plain words, with a toned `badge` for the verdict (Recent, Overdue) (8).

One vocabulary, two surfaces. The web renders it as HTML and CSS; a terminal UI
renders the same names as cells and boxes. If a component is not in these files,
it does not exist — and if you find yourself hand-rolling markup a page already
has a name for, that is the bug.

Read this once. It is short on purpose.

Each section is its own file under `docs/design/sections/`, so a change to one
never conflicts with a change to another. This page is the spine: it orders
them, and the design check (`bun scripts/design-lint.ts`) reads them in this
order — a section file not listed here is not part of the contract. A new
component class is named in `docs/design/areas/<area>.md`, not here.

---

- [1. Principles](design/sections/1-principles.md)
- [2. Tokens](design/sections/2-tokens.md)
- [3. Typography](design/sections/3-typography.md)
- [4. Space, radius, motion](design/sections/4-space-radius-motion.md)
- [5. The component vocabulary](design/sections/5-components.md)
  - [5a. Saying where you are reading from](design/sections/5a-reading-from.md)
  - [5b. The workflow units](design/sections/5b-workflow-units.md)
  - [5c. Apps, runs and the crew](design/sections/5c-apps-runs-crew.md)
  - [5d. Page-local classes](design/sections/5d-page-local-classes.md)
- [6. Keyboard](design/sections/6-keyboard.md)
  - [6a. The code browser](design/sections/6a-code-browser.md)
  - [6b. Code, coloured](design/sections/6b-code-coloured.md)
  - [6c. The editor](design/sections/6c-editor.md)
  - [6·0. The pointer](design/sections/6-0-pointer.md)
  - [6·0a. The dashboard's panes](design/sections/6-0a-dashboard-panes.md)
  - [6·0a·1. Laid out for the terminal it is in](design/sections/6-0a-1-terminal-layout.md)
  - [6·0b. Icons, and the appearance picker](design/sections/6-0b-icons-appearance.md)
  - [6·0c. Pictures in the terminal](design/sections/6-0c-terminal-pictures.md)
  - [6a. Counts and marks on a row](design/sections/6a-counts-and-marks.md)
  - [6b. The workspace — one screen for a whole repository](design/sections/6b-workspace.md)
  - [6c. Editing, and the commit dialog](design/sections/6c-editing-commit-dialog.md)
  - [6c·1. Contributing: fork at the origin, propose a change](design/sections/6c-1-contributing.md)
  - [6d. `$FORGE_EDITOR` — the operator's own editor, over a pty](design/sections/6d-forge-editor.md)
  - [6e. Links that work](design/sections/6e-links.md)
  - [6e·1. Reviews, threads, and the merge gate](design/sections/6e-1-reviews-merge-gate.md)
  - [6f. Realtime](design/sections/6f-realtime.md)
  - [6g. Apps, runs and the crew, where the terminal still shows them](design/sections/6g-terminal-apps-runs-crew.md)
- [7. Two rules that are security boundaries](design/sections/7-security-boundaries.md)
- [8. Checklist before you call a screen done](design/sections/8-checklist.md)
