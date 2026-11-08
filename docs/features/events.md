# Events in the browser

`/:owner/:name/events` (the **Events** tab on a repository, and `<owner>/<name> — Events` in the command palette) lists the repository's events newest first, 50 a page. `?cursor=` pages to older ones; a malformed cursor answers 404.

`?kind=` narrows to one event kind (`?kind=pull.merged`), the same `kind` MCP `events` and `GET …/events` take; one that is not a kind (`validEventsKind`) answers 404. Each row has a button beside it in a person's words ("Merged pulls", from `eventKindLabel`) that links to its kind, 44px tall on a thumb; the raw kind appears only in the URL. A narrowed page says "Showing: Merged pulls" with an **All events** button beside the heading, and the next-page link keeps `kind`. A kind with no events says "No <kind> events" and offers All events.

The audience is the same as MCP `events` and `GET …/events`, because the page reads the same `eventsPage`: a webhook's URL and an app's variable names are the admins'. A public repository answers a guest with 200; a private one answers 404 to anyone who cannot read it. A row links to its page when the event has one (an issue, a push's commits) and is a plain row otherwise.

The terminal's version is `v` on the About card (see the README). `enter` on a row opens the issue or pull the event names (a `pull.*` event opens the pull, any other the issue); the issue and pull screens check access themselves, and `esc` returns to the list at the same row. A push or a settings row names no number and opens nothing, and the key bar shows `enter open` only when the selected row can open something. `t` keeps only the kind of the row under the cursor and `t` again lifts it; `s` keeps only settings changes.
