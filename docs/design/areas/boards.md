# Boards

- `.bform` — the boards form: one row of labelled fields and a button that makes, edits or acts on a board, wrapping onto more lines as the width runs out, with the button sized to its words. Written by `boardsList` (make a board), `panelForm` and `manage` (add or edit a panel; rename, settings, duplicate, delete) in `src/web/pages/boards-view.ts`, and by `boardsPage` (the query form and pin to a board) in `src/web/pages/boards.ts`. Styled in `src/web/style/content.ts` (`.bform` and its `.qf`, `.field` and `.btn` children).
