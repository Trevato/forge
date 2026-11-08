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

## After the pool (#9671)

**Sizing the code-page worker pool from the machine did not cut refusals beyond noise. The default stays 2.**

`src/web/code_rows_pool.ts` now reads `FORGE_CODE_ROWS_WORKERS`: a number (capped at 8), or `auto` for the machine's available parallelism within [2, 8]. Unset, it is 2, as before. That let both sides run from the same tree with no code change between them.

- **Same command:** `bun bench/code-pages-at-rate.ts --rate 500 --seconds 20 --warm 0 --crawl 3000`.
- **Same copy:** this clone's HEAD `b4137c8c`, 5,304 files.
- **Machine:** 80 cores, shared with the load generator, so `auto` is 8.
- **Order of runs:** 2, 8, 8, 2, then 8, 2.

| | served | refused (429) | served/s | p50 | p95 |
|---|---|---|---|---|---|
| 2 workers, run 1 | 7,338 | 2,661 | 367 | 59 ms | 451 ms |
| 2 workers, run 2 | 7,054 | 2,945 | 353 | 122 ms | 595 ms |
| 2 workers, run 3 | 7,856 | 2,143 | 393 | — | 458 ms |
| 8 workers, run 1 | 8,080 | 1,919 | 404 | 26 ms | 414 ms |
| 8 workers, run 2 | 8,081 | 1,918 | 404 | 88 ms | 382 ms |
| 8 workers, run 3 | 7,900 | 2,099 | 395 | — | 399 ms |

All refusals were 429. There were no 503s.

Served/refused per second for the first pair (2 workers, then 8 workers, run 1):

- 2 workers, run 1: `233/266 55/445 258/242 330/170 221/279 236/264 226/274 273/227 367/133 405/95 349/151 500/0 385/115 500/0 500/0 499/0 501/0 500/0 499/0 501/0`
- 8 workers, run 1: `202/297 209/291 280/220 266/234 293/207 302/198 285/215 376/124 489/11 453/47 425/75 500/0 500/0 500/0 500/0 500/0 500/0 500/0 500/0 500/0`

### What this says

- **Refused:** 8 workers refused 1,918–2,099, a mean of about 1,980. 2 workers refused 2,143–2,945 here, and 1,802–2,463 in the "After" runs above. So the 8-worker range sits inside the 2-worker range. In the last back-to-back pair the gap was 44 (2,099 against 2,143).
- **p95:** 382–414 ms with 8 workers, against 451–595 ms with 2 here. That is a little lower, but 376–498 ms above was also 2 workers.
- **The ceiling did not move.** Served/s still levels off at about 400. Seconds 1–4 still refuse 220–300 a second with either size. If two workers at about 5 ms a page had been the limit, eight would have lifted the served rate well past 400. They did not.

**So the pool is not the limit.** That fits the finding above: the refusals come from the strangers' in-flight test (`behindAll`, with the oldest waiting past 250 ms) while git permits are held. The other lever named above, counting queueing at the worker pool rather than at the strangers' gate, has not been tried.

**Memory.** Each worker is about 8 MB of heap when idle (measured with four `code_rows_worker.ts` workers, Bun 1.3.14). The cap of 8 bounds that at about 64 MB idle, more while pages are in flight.
