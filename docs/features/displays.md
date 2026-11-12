# Displays list

A display is a repository with a `display.json` on its default branch (title, layout `shelf`, `grid` or `graph`, and the repositories it draws demos from). The list shows every display you may read, and nothing you may not.

- **Page**: `/displays`. One sentence says what a display is, then one row per display: title (the link to open it full screen), layout, the repository it reads and its demo count. A stranger is sent to sign in. A repository whose `display.json` does not parse is listed as "display.json is invalid", linking to it so its owner can fix the file.
- **Terminal**: the "Displays" screen, opened from the palette. The same sentence (over two rows), then the same rows, with the same 150 ms bound; while it is still reading it says so and fills in the rest when the read finishes. `j`/`k` move.

With no displays, the page says how to make one: commit a `display.json` to a repository's default branch.

If the page says it is still reading some repositories, follow its Reload link: the list never waits on git longer than 150 ms, and until the read is done it never says "No displays".

Not done: the list is read only. Creating or editing a display, a picker, and a thumbnail are separate work.
