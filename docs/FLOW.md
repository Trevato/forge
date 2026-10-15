# The one flow

`src/flow/stage.ts` is a pure function from an issue's records to
`{stage, since, stalled, unblock, pull}`. `src/flow/read.ts` reads those records
(pulls, the checks at each head, reviews, production deploys) and serves
`GET /api/v1/repos/:owner/:name/flow`: `{open: [...], live: [...]}` — every open
issue plus any merged issue production has not yet served (stage `land`, so
`wait for the production deploy` and `redeploy production` show), and what went
live in the last 24 hours.

Stages: issue → pull → check → review → land → live. Stalled past: issue 24 h,
pull 1 h, check 30 min, review 12 h, land 2 h; live never. A pull closed without
merging puts the issue back at `issue`; a re-opened pull counts from the re-open;
with several open pulls the furthest along speaks. An issue is linked to a pull
by `Closes #N` in the pull's body, as the merge itself reads it.
