# One path: check, review, land, live (#7703)

Every change follows four steps, and a person only needs those four words:

1. **Check**: types, lint and the tests the change reaches run on the pull's own code.
2. **Review**: a reviewer approves the change or asks for changes.
3. **Land**: an approved, green pull merges into the default branch.
4. **Live**: a release builds the default branch and production serves it.

`/pipeline` says this to anyone. Each step's finer parts (the check queue, the
proof, the merge queue's gate, the release build and boot check) sit one
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
screen says `step: review` beside `next:` in its header line.
`changeHead` computes "who acts next" once and hands it to `stepOfPull`.

## Not here yet

The rest of #7703 is filed as its own issues: remove the proof (#7779), run
the full suite as a scheduled report (#7780), re-run a shard that crashed
outside any test (#7781), reuse a verdict for the same tree (#7782), carry the
step to the feed and the lists (#7783; the pull page, MCP and terminal have it), and measure each step (#7784).
