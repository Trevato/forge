# Held (the Later gate's proposal)

At rest the proposal is bounded, whatever the gate holds: the heading and a one-line lede, one `.bar` (counts by verdict, then a small "Apply the ticked" in `form.inline`), at most `THEMES_AT_REST` (6) collapsed `.disclosure` theme lines, one "N more themes" disclosure holding the rest, a "How to read this" disclosure holding the help, and "Closed by the review" when it has any. That is at most 6 + 3 one-line folds. No new component class; `form.inline` (content.ts), `.stack-tight` (base.ts), `.disclosure` and the `sm` button are the existing pieces. Written by `heldPage` in `src/web/pages/gate.ts`.

The terminal's held screen (`src/tui/screens/held.ts`) is already a list with one tallied theme header per group and no prose to fold, so it takes no change.
