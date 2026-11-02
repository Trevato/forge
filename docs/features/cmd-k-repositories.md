# Cmd-K: repositories and their apps

One row per repository, under "Repositories". A repository with an app says so on its row ("App · running"); Enter goes to the repository; the app is its own option right under it ("Open the app of owner/name"), so arrow keys, touch and screen readers reach it, and Cmd/Ctrl+Enter on the repository is the shortcut. Only someone who may enter the app is shown it, in the index and in the server's search alike (`enterableApps`).

Ranking: a name typed exactly, then a name it begins, outranks every other kind of match; the viewer's own repositories lead their tier. The index (rendered with the page) holds the viewer's own repositories first, thirty in all; the server's search (`searchLocalRepos`) ranks the same way over a wide page, so a repository outside the index still arrives first.

Still split without earning it (not changed here): the top-nav and `/apps` shelf, the palette's "Apps" and "New app" rows, the TUI palette's repo list.

The terminal's palette (`src/tui/`) is not changed: it lists screens and repositories by its own ranking, and doing both there is a separate, larger change. The index adds one batched read of app state per page render (`statusMany`: one query, in-memory environments); the search reads up to 100 repositories per query.
