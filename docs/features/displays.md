# Displays list

A display is a repository with a `display.json` on its default branch (title, layout `shelf`, `grid` or `graph`, and the repositories it draws demos from). The list shows every display you may read, and nothing you may not.

- **Page**: `/displays`. One row per display: title (linking to the repository), layout, repository, and how many showcased demos it shows. A stranger is sent to sign in. A repository whose `display.json` does not parse is listed as "display.json is invalid", linking to that repository so its owner can fix the file.
- **Terminal**: the "Displays" screen (`src/tui/screens/displays.ts`), opened from the palette. The same rows, from the same `listedDisplays` call. `j`/`k` move.

With no displays the page says what one is and how to make one: commit a `display.json` to a repository's default branch.

Not done: the list is read only. Creating or editing a display, a picker, and a build sidebar are separate work.
