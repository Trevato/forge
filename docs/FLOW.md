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

## The forge's pipeline

`src/flow/pipeline.ts` is the same road seen from the machine, across every
repository: ready → building → check queue → checking → review → approved →
landed → live, each with how much waits in it, how much is being worked, how
long its oldest waiting item has waited, and what limits it (crew runs at once,
checks at once, the autonomous repositories' slots). The stage whose oldest
waiting item has waited longest is the bottleneck. A forge admin reads it at
`/flow` (`web/pages/flow.ts`), one row per stage under one sentence naming the
bottleneck; the knobs stay on Settings → Capacity. The same sentence
(`verdict`) is the terminal's admin-only Flow command and the MCP `flow` tool,
which also returns the stages; anyone but a forge admin is refused.
