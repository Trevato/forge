# How fast a team ships, and what it costs

An org team's page, `/<org>/-/teams/<team>`, opens with its figures for the
last 24 hours and the last 7 days, one row each (#572):

- **Issues closed**: issues closed in the window, per hour.
- **Lead time**: opened to closed, typical (the median) and for the slowest tenth.
- **Planner to builder**: how long a planner's hand-off waits for a builder's run to start.
- **Builder to reviewer**: how long a builder's pull waits for its first review.
- **Sent back**: of the issues closed and pulls merged, the share that had changes requested or were reopened.
- **Conflicts**: of the runs started, the share that went again because main moved under the pull.
- **Cost per shipped change**: what the window's runs cost, over the pulls merged in it.
- **Slots busy**: runs in flight on average, beside how many the team's agents could hold.

A dash is a figure the window has nothing to measure.

**Who sees them.** An admin of the organization only, on every door.

**The three doors.**
- Web: the team's page.
- Terminal: *Organization teams*, enter on a team, then `m`.
- MCP: `org_teams { org, team, action: "metrics" }` returns `{ day, week }`, the same numbers in ms, shares and dollars.

**How fresh.** The figures are read again at most once a minute per team; a
reload inside that minute shows the same numbers. The read is a handful of
index seeks (`run_agent_actor`, `issue_author`, `review_issue`,
`event_repo_kind_seq`), so a team with 10k runs is not a scan of the forge.
