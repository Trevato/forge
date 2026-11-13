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

`readStepStats` (same module, #7784) measures the road's steps over the last
30 days: median time (finished − started) and red rate (failed ÷ ok + failed)
for the pull check, review, proof, merge-queue gate (time only: `check_gate`
keeps a week and no verdict), main's check, release build and verify. The boot
check runs inside the release build and has no run of its own. Review's rate
counts review runs that errored, not changes asked, and says "errored". `/pipeline`
shows them under each step's details, from public repositories alone, held in
memory for the minute so the open page costs one read a minute. The same
numbers, private repositories included for the owner, are the terminal's Flow
dialog ("Steps, 30 days") and the `steps` array of the MCP `flow` tool and
`/api/v1/telemetry/flow` (public repositories alone for an agent).

## Polling `/api/v1/telemetry/flow`

The answer is a copy computed in the background and at most `FLOW_TTL_MS`
(5 s) old, so polling faster than every 5 s only re-reads the same copy. Poll
no faster than every 5 s, and send `if-none-match` with the last `etag`: a
repeat on the same copy is `304` with no body. The response carries
`cache-control: private, max-age=<seconds until the copy is 5 s old>` (wait that
long), `vary: authorization, cookie` (the server appends `Accept-Encoding` on the wire), and an `etag` made from the reader kind
and the copy's computed-at time (the body is never hashed). A `304` is still
counted and still comes after the auth and scope checks. To find a reader that
is too fast, look at `forge_telemetry_reads_total{route="flow",reader=...}` on
/metrics: its rate (`rate(...[5m])`) above 0.2 per second is faster than 5 s.
The MCP `flow` tool is unchanged.

## Rebases

Approved work lands before new work is built, in the check lane too (#6140).
A check on a pull whose last builder's run brought it up to date (a
`conflict` run; a review after it does not count) goes before any other
queued check (`checks/finishing_first.ts`). So the room for more rebases
(`crew/conflict_room.ts`) is the check slots minus the rebases' checks and the
bring-up-to-date runs in flight; a new build's check does not stand in front
of a rebase and takes no room. The finishing pass (`crew/finishing.ts`) gives
the update to the builder who can push the pull's branch — the fork's owner,
else its author — and when that builder already has a run in flight the
update queues behind it: lent to another builder, it could never push
(#7006).

New work is the other way round: the decider's choice of builder is a
ranking, and the most preferred builder with nothing in flight takes the
issue (`rankedBuilder` in `crew/route.ts`), so the slots run more than one
builder. The tick line's `idle` field counts the builders with nothing in
flight beside `active` and `slots`.

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

### What a red batch was (#7639)

`src/flow/culprits.ts` keeps one `queue_verdict` row per red the queue names
(`onVerdict`, a week): `real` — the search found the one pull, handed back to
its builder with the failing tests named, the rest of the batch landing — or
`load` — infrastructure twice (install, setup, timeout) or a flake, no pull
blamed or handed back. `flowFor` carries `redBatches` (counts over 24 h, the
newest five, a sentence) in the MCP `flow` report; boards query the
`queueVerdicts` source. Not done: a pause switch and the "fixed / still there"
effect probe, which belong to the maintenance board (#7561) once it exists.
The terminal Flow dialog lists them too; the how-to is `docs/features/red-batches.md`.

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

## Red pulls that sit (#8245)

`src/crew/stale_reds.ts` `sweepStaleReds(app, repo, now, room)` runs each autonomy tick and reads only the database, so a restart or roll loses nothing. An open crew pull whose latest check on its head failed, with no run in 30 minutes and no person holding or assigned to it, is re-checked (reason `sweep`); still red, its builder is queued with the failing test named, within the free slots and 3 a tick. Past its tries it is parked and its issue is ready again. Red for over 24 h and conflicting with main, or with its issue closed, it is closed with one line. The flow report's `stale_reds` line (`src/flow/stale_reds.ts`) counts the ones not yet handled, and the keeper names `stale_reds` as a cause from 3.

How a person sees stale reds: `bun scripts/flow-report.ts` prints the `stale_reds:` line (count and oldest hours), and the keeper names `stale_reds` as the cause when they are what holds the flow; the terminal Flow dialog draws the keeper's line (`keeperLine`), so it shows there when the keeper picks that cause. It has no line of its own on the dialog.

## Estimates (#11955)

Estimates are recorded against an issue, asked for from the forge's own history and scored: see `docs/features/estimates.md`.
