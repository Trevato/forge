# Pick list

A long list of options to choose many from (#8929), used first by `/forges/new` for the apps to fork and the crew.
`pickList()` in `src/web/pick.ts`; the script (`pickJs`) rides in `shellJs`, the styles in `pickCss`.

- `.pick` — the fieldset. Its options are plain checkboxes in `.pick-list`, a box that scrolls at about six rows, so the form submits and reads with no script.
- `.pick-bar` — a filter (`input[type=search]`) and the `.pick-chips` of what is ticked; hidden until the script runs.
- `.pick-chip` — a button naming one ticked option; pressing it unticks it. Its `aria-label` says "Remove …".
- `.pick-count` — "N of M noun picked", a `role=status` line rendered by the server and kept by the script.

Keys: type to filter; Enter ticks the first match; Down moves into the list, Up/Down walk the visible options, Up from the first returns to the filter; Escape clears the filter.
