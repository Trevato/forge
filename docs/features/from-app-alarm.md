# The from_app alarm (#10563)

A note a signed-in person files from an app becomes a `from-app` issue, assigned on arrival to a free builder of the repo's crew. With every builder busy, or the assignment refused, it stays unassigned. A stranger's note is only a suggestion and is never counted here; hidden notes are left out.

## When the alarm fires

The `from_app` flow alarm (`src/flow/alarm_from_app.ts`) fires when an open person's note has:

- sat **unassigned for 15 minutes**, or
- had **no crew comment for 1 hour** (counted from arrival until the crew first speaks, then from the last crew comment).

It names the issue that has waited longest past its bound. Both doors show it: the Home and `/boards` pages, and the TUI flow screen, which draws every alarm `firedAlarms` returns. `GET /api/v1/flow` lists it too.

## The planner hold

While a person's note in a repository has had no crew comment, that repository's **planner** (the agent with the planner seat) is refused `openPlan` with `from_app_waiting`, naming the issue. Builders, reviewers and people are not held.

The hold lifts as soon as any crew member comments on the note, or the issue is closed, or the note is hidden. A builder that never comments keeps it held; the alarm fires at the hour mark so a person sees it and can comment, reassign or close the issue.
