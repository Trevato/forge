# Estimates (#11955)

An estimate is a promise about when one issue's work happens, kept against the issue and scored. Rows are never edited: a new one supersedes and the old stays as data.

1. **Ask** the base rate for an issue: MCP `estimate` with `{ repo, issue }`, `GET /api/v1/repos/:owner/:name/issues/:n/estimates`, or in the terminal open the repository, choose **Estimates in a repository** from the palette and press `a` on the issue. It comes from the forge's own history (`src/flow/estimate_base.ts`): merged pulls in the last 30 days of the same repository, size and kind (and builder when assigned), measured from the first agent run on the issue (else its creation) to the pull opening, the merge and the release that carried the merge going live. Quantiles are nearest-rank, `sorted[round((n - 1) * q)]`. Under five samples it says so and widens: builder, kind, size, then 90 days. It adds what history does not know (queue position, runs going, budget left, why a release is held) and your own scorecard. Anyone who may read the issue may ask.
2. **Record** one: the same tool with `event` (`pull_opened`, `merged`, `live`, or `done` for an issue that takes several pulls: it is closed and stays closed 24 h, or its last pull is live), `p50`, `p90` (future instants, p50 ≤ p90) and `basis`; `POST` to the same URL; or `r` on the terminal screen, typing `event p50 p90 basis…` (for example `merged 2026-11-14T07:15:00Z 2026-11-14T11:00:00Z a small change`). Only someone with write access, or a crew member on the repository, records, and only on an open issue.
3. **See** it: the issue page and `/next` carry the line ("live by Fri 07:15 (90%: Fri 11:00) · steward · history says Fri 09:40"); `/flow` carries the scorecard.

## What the forge does

Nobody settles an estimate by hand. `src/actions/estimates_settle.ts` is the one place that hears of the events on the bus: a pull that says `Closes #N` opening or merging sets the actual instant of `pull_opened` or `merged`; `release.verified_live` resolves each open `live` estimate at the first release cut after its merge that served. An issue closed as **dropped** or **split**, or moved to **Not now** (`src/actions/next.ts`), voids what it left open: the rows stay, marked void, never scored. Closing as done voids nothing. `done` resolves when the issue closed as done has stayed closed 24 h, or a release carrying its last merged pull went live, whichever came first (`settleDue`: on the events above and every five minutes). A refusal for an event that already happened names the events that can still be estimated.

The basis line ends with how often issues like these were reopened after being closed ("reopened after closing: 3 of 8"), counting the ones reopened and open again: an estimate of "merged" is not an estimate of "works".

`live` needs a release on record. A release the keeper cut is. One shipped by hand (a tag, an image built on the host, the container restarted with `FORGE_VERSION` and `FORGE_COMMIT`) is recorded by the forge at its own boot when that stamp is newer than the newest release that served (`src/keeper/by_hand.ts`: went live = boot time, `how` = "by hand"). Releases shipped by hand before this one are not back-filled, so a merge made before it resolves `live` at the first recorded release after it. `live` resolves only for the forge's own releases, not an app's production deploy.

## Scores

`src/flow/estimate_score.ts`: ratio = actual / p50 duration, both from the moment the estimate was made; the median ratio is the bias; the p90 hit rate should be about 90%. Only an estimator's first estimate per issue and event counts, so revising late cannot improve a score. The base rate shown at the time is scored as the estimator `history`. The scorecards read the newest 5,000 estimates in repositories the viewer may read, so a private repository's estimators, sizes and counts show only to those who can open it.

Tests: `test/estimates.test.ts`.
