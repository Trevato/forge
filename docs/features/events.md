# Events in the browser

`/:owner/:name/events` (the **Events** tab on a repository, and `<owner>/<name> — Events` in the command palette) lists the repository's events newest first, 50 a page. `?cursor=` pages to older ones; a malformed cursor answers 404.

The audience is the same as MCP `events` and `GET …/events`, because the page reads the same `eventsPage`: a webhook's URL and an app's variable names are the admins'. A public repository answers a guest with 200; a private one answers 404 to anyone who cannot read it. A row links to its page when the event has one (an issue, a push's commits) and is a plain row otherwise.

The terminal's version is `v` on the About card (see the README).
