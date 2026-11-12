# Iterations

A fork family's build pins (`/:owner/:name/iterations`), after Jay Moran's page: fork cards in columns by fork depth, or (`?layout=tree`) a downward tree of runs, and under them a player and an info panel. `iterationsPage` in `src/web/pages/iterations.ts` draws it from the data in `src/core/iterations.ts` (kept five seconds per repository, `src/core/ttl_cache.ts`); `ITERATIONS_CSS` there holds the page's rules, and `INFO_CSS` in `src/web/pages/build_info.ts` the player's and info panel's. Notes is `data-notes` on `.it-page`, not a class. The picker, Showcased and Edit display selections wait for displays.

- `.it-page` — the page below the repo header; carries the Notes state the rules below read.
- `.it-checks` — the head's controls: the layout switch (`.it-seg`, Columns / Tree) and Notes.
- `.it-key` — the one-line key under the head: a solid line for fork of, a thin one (`.it-thin`) for a branch, a dashed one (`.it-dash`) for built on a pin of; `.it-sp` holds Collapse / Expand forks, zoom with Fit (`.it-zc`), and in the tree Align and Reset.
- `.it-stage` — the graph pane: at most 60% of the viewport high, scrolling both ways; `.it-zoom` its sized box.
- `.it-grid` — the columns, one per fork depth; `.it-col` is one column. `.it-tree` is the tree's scaled canvas.
- `.it-edges` — the SVG of lines between cards, drawn by the page's script.
- `.it-fork` — one fork's card; `.it-head` its name, `.it-rows` its builds; `.it-shut` folds it to its name.
- `.it-lane` — one run of the tree, placed by the script and dragged by hand (`.it-dragging`); `.it-lh` its head with `.it-nm` the fork's name (folds the fork) and `.it-ct` (folds the run); `.it-branch` a run that splits off a build with `.it-sub` its title; `.it-runshut` and `.it-hid` its folds.
- `.it-coll` — the one node a fold leaves (`.it-fcoll` a fork, `.it-rcoll` a run): a borderless row inside the card, hidden until its fold is shut.
- `.it-b` — one build row: `.it-l` label, `.it-d` date, `.it-n` the note line (the notes' first line). `.it-sel` is picked, `.it-tip` is a branch with no pin.
- `.it-pane` — the player and the info panel side by side; one column on a phone.
- `.it-player` — the player: `.it-bar` its title row, `.it-empty` a message or form in its place, `.it-foot` the build's line.
- `.it-info` — the info panel's sections; `.it-notes` the Notes section, `.it-body` its text, `.it-acts` the Actions row, `.it-cmd` the read-only link or commands in an action's dialog; `.it-dlg` marks those dialogs for the script.
- `.it-notelist` — the notes as one list; `.it-note` one note, `.it-note-human`, `.it-note-agent` and `.it-note-pin` by who wrote it.
- `.it-edit` — a section's quiet Edit link; `.it-ed` the form it opens in place, `.it-ed-foot` its Cancel and Save, `.it-saved` the line that says it saved or why not, `.it-none` the empty Notes line.
