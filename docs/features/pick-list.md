# Pick list (#8929)

`/forges/new` chooses the apps to fork and the crew whose briefs go along from a pick list, not a page of checkboxes. The component is `pickList()` in `src/web/pick.ts`, for any long pick list; its styles and keys are in `docs/design/areas/pick.md`.

**Using it.** Type in the filter to narrow the list; tick options in the short list below it. What is ticked shows as chips above, each a button that unticks it, and a line counts "N of M repositories picked". The chip bar scrolls past a few rows, so the form stays on one screen on a phone.

**Keys.** Enter ticks the first match. Down moves from the filter into the list; Up and Down walk the visible options; Up from the first returns to the filter. Escape clears the filter. Space ticks the focused option, as any checkbox.

**Without JavaScript.** The options are plain checkboxes in a box that scrolls; the form submits as before. The filter and chips appear only when the script runs.

**Screen readers.** The options are native checkboxes in a fieldset with the legend as its name. A refusal is read with the fieldset (`aria-describedby`). The count is announced when a pick changes, not while filtering.

**The terminal.** `forge` TUI's new-forge screen takes `owner/name` apps as a comma-separated text field and has no checkboxes; it is unaffected.

**Which repositories.** The apps list offers each repository once, as its source (#11623): your own public repositories first, then other people's public source repositories that run an app. A crew agent's repositories, archived ones, and any fork whose parent is also offered are left out, decided in SQL before the 200-row limit so a parent is never cut while its fork stays. The list is a convenience, not the boundary: the submit check still accepts any repository the person may read, because the terminal field and the API take free `owner/name`.
