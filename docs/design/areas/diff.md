# Diff

The diff a pull and a commit show is one component, drawn by `renderDiff` in `src/web/diff-view.ts` and styled in
`src/web/style/content.ts`. It is a `.diff` wrapper holding a summary line and one §5 **diff file** (`.diff-file`) per
file; the line kinds and gutters (`.add`, `.del`, `.dh`, `.dl`, `.dn`, `.wd`) stay in §5d.

- `.diff-summary` — the card above the files: how many files changed and the `+`/`−` totals, in their add and delete colours.
- `.diff-head` — a file's `<summary>` row: the fold chevron, path, status badge, line counts and the Viewed checkbox; sticky under the top bar, and wraps when its card is narrower than 420px.
- `.diff-path` — the file's path (or `old → new` for a rename) in the head, monospace and truncated with its full path as the title.
- `.diff-stat` — a file's `+`/`−` line counts, in the head and in a stub.
- `.diff-body` — the file's contents under its head: scrolls sideways for long lines, hidden once the file is marked viewed.
- `.diff-table` — the table of hunks and rows inside the body, monospace at 12.5px.
- `.diff-note` — a centred muted line in place of rows: a binary file, no content changes, or files past the cap not shown.
- `.diff-stub` — a `.diff-note` for a file too large or generated to draw: why, its real counts and a View file button.
- `.dn-comment` — a line number in the gutter that links to commenting on that line, when the diff is reviewable.
- `.nonl` — the `↵` mark after a line that has no newline at the end of the file.
