# Iterations

A fork family's build pins (`/:owner/:name/iterations`) as a downward tree of runs, reached from the Builds page. `iterationsPage` in `src/web/pages/iterations.ts` draws it; `iterations_family.ts` holds the data (`iterationsOf`, `lanesOf`) and `iterations_script.ts` the rules (`ITERATIONS_CSS`) and the script. Without the script the runs stand side by side; with it each run hangs under the build it grew from.

- `.it-page` — the page below the repo header; carries `data-here` and `data-lanes` (the runs, as JSON) for the script.
- `.it-key` — the one-line key: solid line for fork of, thin for a branch (`.it-thin`), dashed (`.it-dash`) for built on a pin of; `.it-sp` the Collapse/Expand forks and zoom buttons (`.it-zc`), shown only once the script adds `.it-on` to `.it-page`.
- `.it-stage` — the graph pane: at most 60% of the viewport high, scrolling both ways; `.it-zoom` its sized box, `.it-tree` the scaled grid (`.it-placed` once the script has placed the runs).
- `.it-edges` — the SVG of lines from a build to the head of the run that grew from it.
- `.it-lane` — one run: `.it-lh` its head with `.it-nm` the fork's name (the script makes it a button that folds the fork) and `.it-ct` (a `btn` the script adds, folds the run); `.it-branch` a run that splits off a build; `.it-shut` and `.it-runshut` its folds, `.it-hid` a branch whose fork is folded.
- `.it-coll` — the one node a fold leaves (`.it-fcoll` a fork, `.it-rcoll` a run): a full-width, borderless row that is part of the card, not a `btn`; hidden until its fold is shut.
- `.it-rows` — a run's rows; `.it-sub` the title of a branch run.
- `.it-b` — a build row: `.it-l` label (monospace), `.it-d` date, `.it-n` the note's first line.
