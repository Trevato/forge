# The landing line: when an approved pull will land

This page is for anyone waiting on a pull. Once a pull is open and approved, it says where it stands in the landing queue and about when it will land.

## Where to read it

- **The page:** a muted line under the pull's path, for example `first in the queue: lands in about 15 min`.
- **The terminal:** the same words in the pull screen's header line, after the step.
- **The `pull` tool:** `eta: { minutes, says }`. `says` is the same text; `minutes` is the number, or null when there is no pace to read. `eta` is null unless the pull is open, approved and not landed.

All three call `landingLine` in `src/flow/landing_line.ts`, so they never disagree.

## How place and pace are read

- **Place:** the repository's open, unlanded pulls whose latest review is an approval (no changes requested after it), ordered by when they were approved. The pull's index is the number ahead of it: `first`, then `number 2`, and so on.
- **Pace:** the pulls the repository landed into its default branch in the last hour, and the median length of its finished merge-queue gates in the last 6 hours. `src/flow/landing_eta.ts` turns place and pace into minutes and words; with no pace at all it says so instead of guessing.

The line is an estimate from recent history, not a promise: a red check, a conflict or a hold moves it.
