# Display

One repository's display: the builds its `display.json` (on the default branch) shows. Read only.

- **Page**: `/<owner>/<repo>/display`. Server-rendered. The title and layout, then one row per build: name, version, and, when you may read the build's repository, links to its screenshots and the repository. A build whose repository you cannot read shows its name and version and "Private", nothing more. A `display.json` that does not parse shows its error.
- **404**: a repository with no `display.json`, one that does not exist, and one you may not read all answer the same 404.
- **Reaching it**: each row of `/displays` links to it.
- **Terminal**: in a repository's screen, the palette command "<owner>/<repo> — Display" (`src/tui/screens/display.ts`) shows the same title, layout and builds with the same open/private split, from the same `displayOf` and `displayItems`. `j`/`k` move, `esc` goes back. A repository you may not read is not offered it, and the screen itself says "No display here".

Not done: ticking builds, editing the title, covers, the player and the Arcade host. See `docs/features/displays.md` for the list.
