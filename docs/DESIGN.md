# DESIGN.md — the forge's design system

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
