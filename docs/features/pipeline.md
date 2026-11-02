# One path: check, review, land, live (#7703)

Every change follows four steps, and a person only needs those four words:

1. **Check**: types, lint and the tests the change reaches run on the pull's own code.
2. **Review**: a reviewer approves the change or asks for changes.
3. **Land**: an approved, green pull merges into the default branch.
4. **Live**: a release builds the default branch and production serves it.

`/pipeline` says this to anyone. Each step's finer parts (the check queue, the
merge queue's gate, the release build and boot check) sit one
click down in a `<details>`. The live counts per stage stay on `/boards`,
whose Pipeline panel links back to `/pipeline`.

## Where a pull is

`src/flow/path.ts` decides it: `pathStep` is plain data in, plain data out,
and `stepOfPull` reads one pull's facts. The rule is "the earliest step not
yet passed":

- **check** while a check on the head is queued, running, red or cancelled
  (if no check is recorded, there is nothing to wait for);
- **review** while it is green (or has no check) and nobody has approved this head;
- **land** once it is approved and green;
- **live** once merged into an app's default branch, `done` when a production
  deploy has served since the merge. A merge where nothing deploys ends at
  **land**, `done`.

For an open pull the sentence comes from `nextActor` (`src/flow/next_actor.ts`),
so the step line and the "Next:" line never disagree. On the check step the
check is the reason, even before anyone has reviewed.

Under every pull's title (both tabs) the line reads, for example,
`Check · **Review** · Land · Live — No review yet.`, linked to `/pipeline`.
A finished path (live, or landed where nothing deploys) carries a "done" badge.
The MCP `pull` tool answers `step: { step, why, done }`, and the terminal's pull
screen says `step: Review — No review yet.` beside `next:` in its header line.
The same word and sentence (from `stepOfStored`) sit on a pull's post in the feed,
its row on the repository's pulls list and on `/review` (the word links to
`/pipeline`), and under its row in the terminal's feed, pulls list and on-you
list (#7783). List rows skip the merge-conflict probe (it costs a git run per
pull), so a conflicted pull can read differently on its own page than on a list;
the row links to the pull, whose page answers.
The step is looked up per row (a few queries each); batching it is left for when
the lists measure slow.
`changeHead` computes "who acts next" once and hands it to `stepOfPull`.

## The full suite as a report

A verification after landing (`src/checks/verify.ts`) runs every shard against
the default branch's tip. When it is red, `src/checks/report.ts` files one
issue per failing test file through `fileIssueOnce` (`src/checks/flake.ts`),
titled `Full suite red: <file>` and labelled `full-suite`; a later red adds a
comment to the open issue instead of filing again. Nothing that decides a
pull, a batch or a release reads a verification, so the report holds none.

How it is scheduled: the checks service looks every minute (`VERIFY_SWEEP_MS`)
for a repository whose default branch has moved since its last verification
and verifies it, at most once per `VERIFY_EVERY_MS` (30 minutes, set in
`src/main.ts`) and never two at once. So the report runs after a landing, not
on a daily clock: a quiet main is not re-run, a busy one at most every half hour.

`/pipeline` links the label (in the forge's own repository, `ownRepoPath()`)
in the card under "Where to look next". The terminal's Flow dialog ends with
a line counting the open report issues; the issue list there filters by
label with `l`.

## Not here yet

The rest of #7703 is filed as its own issues: re-run a shard that crashed
outside any test (#7781), reuse a verdict for the same tree (#7782), and measure each step (#7784).
