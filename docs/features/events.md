# Events in the browser

`/:owner/:name/events` (the **Events** tab on a repository, and `<owner>/<name> — Events` in the command palette) lists the repository's events newest first, 50 a page. `?cursor=` pages to older ones; a malformed cursor answers 404.

The audience is the same as MCP `events` and `GET …/events`, because the page reads the same `eventsPage`: a webhook's URL and an app's variable names are the admins'. A public repository answers a guest with 200; a private one answers 404 to anyone who cannot read it. A row links to its page when the event has one (an issue, a push's commits) and is a plain row otherwise.

The terminal's version is `v` on the About card (see the README). `enter` on a row opens the issue or pull the event names (a `pull.*` event opens the pull, any other the issue); the issue and pull screens check access themselves, and `esc` returns to the list at the same row. A push or a settings row names no number and opens nothing, and the key bar shows `enter open` only when the selected row can open something.
