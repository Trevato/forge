# Dialog

A §5 `.dialog` is one component in three parts: a head that names it, a body that holds what it asks or shows, and a
foot of buttons aligned to the end. The shell's keyboard-shortcuts dialog (`overlays()` in `src/web/layout.ts`) and the
limb page's confirm form (`limbPreviewPage()` in `src/web/pages/limb.ts`) both draw it; the rules live in
`src/web/style/components.ts`.

- `.dialog-head` — the dialog's first row: its `h2` title (which `aria-labelledby` names) takes the width, anything beside it sits at the end.
- `.dialog-body` — the dialog's content, padded to the head's inset; add `.stack` when it holds several fields.
- `.dialog-foot` — the dialog's actions on one row, aligned to the end, the primary or danger button last.

The confirm page before a destructive route (`confirmPage()` in `src/web/pages/search.ts`) is not a dialog: it is a page
heading, the one sentence of what will happen, the typed phrase when needed, and the action beside a way back, with no box
and no new class.
