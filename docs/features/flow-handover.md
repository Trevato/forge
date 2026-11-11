# Flow: where the crew gives up (#11456)

`/flow` (owner only) shows one section under the pipes, "Where the crew gives up": plain rows, one intro line, and only the lists that have rows. Nothing is drawn when all three are empty. The reads are `src/flow/handover_read.ts` (open pulls only; two queries for review verdicts however many pulls are open); the markup is `src/web/pages/flow-handover.ts`.

| List | Pure rule | Reads |
| --- | --- | --- |
| Handed to a person in the last 24 h | `src/flow/handovers.ts` (`inWindow`) | the newest "Handed to a person by the crew:" note on an open pull, written under the assignee's name |
| One review round from a hand-over | `src/flow/review_rounds.ts` | open pulls whose trailing run of changes-requested reviews is two |
| Bring up to date first | `src/flow/rebase_first.ts` | at most five open pulls behind main (the drifts `/boards` reads), approved first, held never |

Both doors: the terminal Flow dialog (`src/tui/screens/flow.ts`) shows the same lists for a site admin who is a person; the digits 1-5 bring the numbered rebase pull up to date through `askUpdate` (`src/tui/screens/drift.ts`), which makes the same checks as `updateSubmit` (visible, writer, open). On the page each rebase row has the existing `POST /:owner/:name/pulls/:number/update` form; `updateSubmit` checks same-origin and takes `back` only when it is a local path.

`readDrifts` skips a repository whose name is unsafe for a directory; every other error surfaces.

Cost: `/flow` now awaits `readDrifts`: one `rev-parse` per open pull's base branch (shared per repository) plus a drift read per pull, both cached per head and tip, so a warm load is a map lookup and a cold one is git-bound.

No API route carries these lists yet; left out on purpose.

Tests: `test/flow-handover-page.test.ts`.
