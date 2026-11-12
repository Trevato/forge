# Diff

The diff a pull and a commit show is one component, drawn by `renderDiff` in `src/web/diff-view.ts` and styled in
`src/web/style/content.ts`. It is a `.diff` wrapper holding a summary line and one §5 **diff file** (`.diff-file`) per
file.

- `.diff-summary` — the card above the files: how many files changed and the `+`/`−` totals, in their add and delete colours.
- `.diff-head` — a file's `<summary>` row: the fold chevron, path, status badge, line counts and the Viewed checkbox; sticky under the top bar, and wraps when its card is narrower than 420px.
- `.diff-path` — the file's path (or `old → new` for a rename) in the head, monospace and truncated with its full path as the title.
- `.diff-stat` — a file's `+`/`−` line counts, in the head and in a stub.
- `.diff-body` — the file's contents under its head: scrolls sideways for long lines, hidden once the file is marked viewed.
- `.diff-table` — the table of hunks and rows inside the body, monospace at 12.5px.
- `.diff-note` — a centred muted line in place of rows: a binary file or no content changes. Files past the cap are not a `.diff-note`: the cut is a plain `p.muted.small` line under the last file, with its own 12px top margin.
- `.diff-stub` — a `.diff-note` for a file too large or generated to draw: why, its real counts and a View file button.
- `.dn-comment` — a line number in the gutter that links to commenting on that line, when the diff is reviewable.
- `.dc-thread` — an open line-comment thread under its row: each comment is a muted author·time·"outdated" line (`.comment-head`) over its prose, with no card; the Resolve button follows. A resolved thread stays a card with its disclosure.
- `.nonl` — the `↵` mark after a line that has no newline at the end of the file.
- `.diff` — the wrapper around one whole diff: its summary and every file.
- `.dl` — one line of a hunk, a table row; its `data-k` says whether it is context, added or deleted.
- `.dn` — a line number in the gutter.
- `.dh` — a hunk head, the `@@` row that opens each hunk.
- `.add` — an added line, in the add colours.
- `.del` — a deleted line, in the delete colours.
- `.wd` — a changed word inside an added or deleted line, underlined on a stronger tint.
- `.tok-inserted` — an inserted token in highlighted code, in the add colour.
- `.tok-deleted` — a deleted token in highlighted code, in the delete colour.

The commits list and a commit's page (#9348) add no class: inside `[data-commits]` (an attribute, `COMMITS_CSS` in `src/web/pages/commits.ts`) a row's subject and author wrap, a long word breaks anywhere, and the diff scrolls inside its own `.diff-body`.
