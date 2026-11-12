# Growth and the planner switch

Open `/:owner/:name/queue`, or "Queue" in the terminal's palette while a repository is open. It shows, for the
last 14 days, issues opened and closed, pulls opened, landed and closed unmerged, the open totals, who opened
the issues (owner, people, planner, builders, watchers) and a row for each day, with two plain sentences: how
fast the list grows or shrinks and how many days of work are queued at the current pace. The oldest open pull
and the oldest issue no run has started on sit above. Sealed issues are left out of every number and title for
anyone who may not see them (`core/sealed.ts`). No dollars are shown.

**Planner: on / paused.** The owner (a person who administers the repository) pauses it until they switch it on,
until the weekly reset (the account's own reset when one is read, else Monday), or until a time (UTC, within a
year). Paused, the planner opens no issues (`planner_paused`), adds no plan and starts no run; builders and
reviewers keep finishing what is queued. A pause lifts itself at its time. The page suggests a pause when the list
has grown three days running or queued work passes two weeks of pace; it never pauses by itself. In the terminal:
`o` until I switch it on, `w` weekly reset, `t` a time, `n` switch on. `planner.paused` and `planner.resumed` are
heard by the admins.

`GET /api/v1/repos/{owner}/{name}/growth?days=14` answers the same numbers (`days` 1 to 90), whether the planner
is paused, and what the caller may see.

Closed-per-day has no index of its own: it walks the repository's rows through the existing `repo_id` index
(one made the retrospective's plan sort). Opened-per-day uses `issue_repo_created`.

Not done: the MCP tool for the switch (the API and both doors are the way in for now), the panel on the
repository home, one action per aged item, and "until the chapter closes" (the forge has no chapters).
