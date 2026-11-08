# A cold forge at 500 a second, before and after #9633 (#9664)

**After still refuses strangers: about 1,800–2,500 of 10,000 in 20 s, against 3,700–4,700 before.**
This file records a measurement. It closes nothing else.

Command, each side run twice:
`bun bench/code-pages-at-rate.ts --rate 500 --seconds 20 --warm 0 --crawl 3000`
(in-process forge, Shield at `ceiling`, edge bypassed, 3,000 distinct pinned code pages from 4,000 made-up addresses).

- **Same copy:** both sides serve the same history, this clone's HEAD `1b1f8f3a`, 5,296 files.
- **Before:** the tree at `1b1f8f3ad^` (`e1df5e6c`), taken with `git archive`. Its bench script points at this clone, so it fetches the same history.
- **After:** main at `1b1f8f3a`.
- **Machine:** 80 cores, shared with the load generator.

| | served | refused (429) | served/s | p50 | p95 |
|---|---|---|---|---|---|
| Before (`e1df5e6c`), run 1 | 5,283 | 4,716 | 264 | 210 ms | 633 ms |
| Before (`e1df5e6c`), run 2 | 6,263 | 3,736 | 313 | — | 540 ms |
| After (main `1b1f8f3a`), run 1 | 8,197 | 1,802 | 410 | — | 376 ms |
| After (main `1b1f8f3a`), run 2 | 7,536 | 2,463 | 377 | — | 498 ms |

All refusals were 429. There were no 503s.

Served/refused per second (the 21st bucket is the empty tail):

- Before, run 1: `212/287 29/470 201/299 152/349 185/315 180/320 202/298 142/358 185/315 280/220 261/239 303/197 304/196 292/208 346/154 349/151 263/237 397/103 500/0 500/0`
- Before, run 2: `154/345 200/300 190/310 187/313 54/446 234/266 233/267 227/272 237/264 275/225 283/217 387/113 410/90 333/167 359/141 499/0 501/0 500/0 500/0 500/0`
- After, run 1: `227/272 263/235 266/236 242/257 330/171 390/110 434/66 378/122 404/96 375/125 500/0 500/0 444/56 444/56 500/0 500/0 500/0 500/0 500/0 500/0`
- After, run 2: `229/270 237/263 200/300 241/259 273/227 305/195 375/120 234/271 401/99 314/186 357/143 370/130 500/0 499/0 501/0 500/0 500/0 500/0 500/0 500/0`

Each pair of runs differs by about 20%: the load generator shares the machine. The gap between before and after is larger than that.

After, compared with before:
- **Refused:** about half as many.
- **Served:** about 1.4× as many a second.
- **p95:** about 30% lower.
- **When refusals stop:** after second 12–13 in both after runs, against second 16–19 before (except two dips of 56 in after run 1).

## Where after still refuses

- **How many:** 1,802 and 2,463 strangers.
- **When:** seconds 1–12, worst in seconds 1–4 (235–300 a second), then falling to 56–186 a second.

**Why: the stranger budget, set off by its in-flight test, not by the loop.** Strangers' pages wait for the strangers' share of the git pool (4 permits, half of 8). When 32 are in flight and the oldest has waited 250 ms, `behindAll` (60 a minute for all strangers together) takes over. That turns away most of each second's arrivals.

One extra run of main used a probe that was never committed (in a `$TMPDIR` copy of `crawl.ts`). Each second it logged the loop's lateness, which test said "behind", and the strangers' gate:

- **Loop:** average lateness 1–21 ms, never past the 50 ms threshold.
- **The test that fired:** every one of the ~2,200 refusals came from the in-flight test, none from the loop test.
- **The gate:** 4 active, 19–95 waiting, while refusals ran.

That probe run served 7,800 and refused 2,197, p95 416 ms, within the range of the two after runs.

**Widening the share does not help.** One run of main with `FORGE_STRANGER_CODE_CONCURRENCY=8`, an existing override with no code change, served 7,410 and refused 2,589, p95 441 ms. That is within noise of 4 permits, so the queue is behind the gate, not the gate itself.

## The next lever, as an idea (not built, not measured)

The code-page worker pool is fixed at two (`WORKERS = 2` in `src/web/code_rows_pool.ts`). 9630-worker.md puts a cold page's off-thread work at about 5 ms: about 4 ms to encode, about 1 ms for the rows. Two workers at that cost top out near 400 pages a second, which is where after levels off (377–410 served a second).

If that is the limit, the next things to try are:
- size the pool from the machine, with an environment override like the git pool's;
- or count queueing at the worker pool rather than at the strangers' gate.

Each needs this same bench as its done-test.

## What this pull does not do

- **No code under `src/` changes.**
- **The kept-pages-across-a-swap idea (#9631, pull #9632) stays dropped.**
- **The run on the deployed edge is not repeated here.** That is `bench/load.ts` against the deployment (docs/features/load-test.md).
