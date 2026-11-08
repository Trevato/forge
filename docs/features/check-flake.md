# Flaky tests on main (#6643)

A default-branch check that fails **one or two named tests** re-runs only those
tests once, alone (`bun test <file> -t <name>`), on the same commit in the same
cell, before main counts as red (`src/checks/flake.ts`, wired in
`checks/service.ts`).

- They pass alone: the check is **green**, so no red-main hold (`checks/red_main.ts`)
  starts. Each is a row in `check_flake`; the check's log says
  `flaky: … recorded, main stays green`.
- One fails alone too, or the red was a build error, a hook, a timeout or more
  than two tests: **red, unchanged**.
- A test that flakes **twice in 7 days** gets one issue (`Flaky test: <name>`,
  `Files:` its file). An open issue by that title is not filed again.
- The week's list is `flakes` in the vitals (the health answer for an admin):
  `repo`, `test`, `file`, `count`, `lastCommit`, `last`. A site admin reads it as
  "Flaky this week: …" under the forge notes on the home board and in the terminal's
  dashboard strip. It never degrades the forge.

Left out: pull checks (they keep failing as before, shared with main by name),
cluster Jobs (the re-run needs the check's own cell), and hook or `(unnamed)`
failures, which have no name to select by.
