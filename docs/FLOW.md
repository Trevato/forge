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

## Rebases

Approved work lands before new work is built, in the check lane too (#6140).
A check on a pull whose last builder's run brought it up to date (a
`conflict` run; a review after it does not count) goes before any other
queued check (`checks/finishing_first.ts`). So the room for more rebases
(`crew/conflict_room.ts`) is the check slots minus the rebases' checks and the
bring-up-to-date runs in flight; a new build's check does not stand in front
of a rebase and takes no room. When the pull's own builder already has a run
in flight, the finishing pass (`crew/finishing.ts`) lends the update to an
idle builder, round-robin by name; the run's agent is who rebased, and the log
line names whose pull it was.

The tick line's `lane` field, the `Rebases:` line on `/flow` and in the
terminal's Flow, and `rebases` in the MCP `flow` tool all read
`conflicted N, rebasing M, room R`: the conflicted pulls (with the approved
ones still waiting for room, which have no run yet), the bring-up-to-date runs
and their checks in flight, and the runs the lane has room to start now.

## Red batches

`src/flow/red_batches.ts` `readRedBatches(db, now, publicOnly)` says, of the
merge-queue batches judged in the last 6 hours, how many went red:
`{ finished, red, rate }`, `rate` null when none finished. A batch is one
candidate the queue judged (`checks/queue.ts` calls `onBatch` beside its
in-memory hourly count): a red batch's bisection prefixes and its head gated
alone are its search, not batches; re-checks, cut-off gates and pull checks
are not counted. Each verdict is a row of `queue_batch`, kept a week. The
`publicOnly` rule is `readVitals`'s. Nothing shows it yet (#5930).

## Throughput

`src/flow/throughput.ts` counts what each pipeline stage let out over the last
24 hours, hour by hour, from the same records (no table of its own): issues
started (the first builder start per issue), pulls opened, checks started,
checks finished (passed or failed; cancelled is not finished), reviews returned
(review runs that finished ok), landed (merged into a default branch), released
(`release` rows whose preflight passed), live (production deploys serving). It
also gives the median ask→live over the merges that went live in the last 24
hours: from the oldest issue the pull closes (the pull itself when it closes
none) to the first production deploy created after the merge serving.

On `/flow` each stage's row shows its count for the last hour, a 24-bar
sparkline (oldest on the left) and the 24-hour count; the headline adds
"landed N in the last hour · M in 24 h · median ask→live X h (24 h)". The
sparkline is a picture only (`aria-hidden`, no links, no tab stops): the two
counts beside it are the way in, two tab stops per row. Each count links to
`/flow?out=<what>[&hour=0]`, which lists the items it counted (any `hour`
from 0 to 23 may be asked for by hand); an unknown `out` or hour lists
nothing.

The MCP `flow` tool returns the same numbers under `throughput`: `says` (the
headline sentence), `medianAskToLiveMs`, and per stage `key`, `out`, `label`,
`lastHour`, `day` and `hours` (24 counts, 0 the last hour). The terminal's
Flow command, a forge admin's like the page, opens a dialog with the
bottleneck sentence, the headline and one line per stage of its last-hour
and 24-hour counts. A sealed issue is counted, its title is
not shown.

Under the pipeline, `/flow` shows each autonomous repository's ready list as
one bar (#2244): what a builder could start beside the count per filter that
holds the rest — `crew/held.ts`'s `heldBy`, the same counts the autonomy
tick logs as `held=`, read through `flow/held.ts`, which keeps the rows 5 s.
The terminal's Flow command prints the same rows, one line per repository
(`alice/engine startable=0 stalled=4 run_cap=1`). A granted agent sees
public repositories only, on both.

One of those filters is the hot-file WIP limit (#5934, `crew/hot_files.ts`):
a ready issue that names a file 5 or more open pulls already touch is held as
`hot_file` until that pile drains under 5, so a sixth pull never joins a
file every landing would make the rest rebase. An issue's expected files are
the repository paths its title and body name (`src/http/mcp.ts`,
`` `README.md` ``); an open pull's files are read from git once per head
before the picker sorts. The tick line names the hot files (`hot=src/http/mcp.ts=61`),
and each repository's writers see one post on the feed — on the web and
through the MCP `feed` tool — saying which build waits on which file, gone
when the hold lifts. A pull whose diff touches more than 60 files counts
toward no file's heat and is named on the feed (`too wide to count: #4840
(1,081 files)`), even when no build is held.

## Flow reads, in one page

`bun scripts/flow-report.ts [--db <path>] [--public] [--json]` (database read-only, default `forge.db` under `FORGE_DATA`; `--json` for raw values) prints one line per read of `src/flow/report.ts`: `build_yield` (agent runs finished in 24 h: how many pushed, landed, closed), `review_latency` (median hours from opening to first verdict), `outsiders` (open pulls by non-writers and non-crew, oldest in hours), `checks_pile` (open pulls red or waiting for a check slot), `gate_minutes` (check-slot minutes in 1 h and 6 h), `oldest_approved` (the longest-waiting approved pull), `idle_pulls` (crew pulls untouched for 72 h), `lead_time` (opening to landing, 24 h) and `openers` (who opened the last hour's pulls). The script reads everything; `--public` cuts it to public repositories.
