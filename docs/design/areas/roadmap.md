# Roadmap (the map's first view, #10303)

The pillars in order, one `row()` each, folded (`fold`): the current pillar
open, the rest closed. Inside a pillar, groups of rows (Building, Up next,
Waiting on a pull, Blocked, Done this week). Needs you is a list of rows.
No border, no card, no progress bar; the pace is one sentence.

New classes, besides the live region `.rm`:

- `.rm-group` (with its `h3`): a muted small heading over a group of rows
  inside a folded pillar; no existing component names a group of rows.
- `.rm-moved`: the "moved" marker after a title, muted (never accent: it is
  not interactive).
- `.rm-pace`: the one-sentence pace line (a plain paragraph).
