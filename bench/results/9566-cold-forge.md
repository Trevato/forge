# A cold forge at 500 a second (#9566)

**No kept change: this is a measurement, and it does not close #9566.** The refusals stand
at the "before" below. The two fixes that could remove them are tracked as #9630 (render a
cold page off the main thread) and #9631 (carry kept pages across a release swap), both
blocking #9566.

Command: `bun bench/code-pages-at-rate.ts --rate 500 --seconds 20 --warm 0 --crawl 3000`
(in-process copy, edge bypassed, 3,000 distinct pinned code pages, this clone's history).

| | served | refused (429) | served/s | p95 |
|---|---|---|---|---|
| Before (main, d338b5aa) | 4,424 | 5,574 | 221 | 827 ms |
| Before, second run (same code) | 3,779 | 6,220 | 189 | 927 ms |
| Experiment A: ignore loop lateness and queueing for the first minute (reverted) | 4,300 | 5,699 (as 503) | 215 | 2,442 ms |
| Experiment B: index the router by first segment, two-phase match (reverted) | 3,779 | 6,220 | 189 | 927 ms |

Per second, served/refused, before: `202/297 15/485 198/302 144/356 105/395 123/377 189/311 176/324 220/280 199/301 178/322 241/259 189/311 279/221 316/184 210/290 339/161 293/207 500/0 308/191`.
Second run: `214/285 63/437 96/404 166/334 159/341 100/400 91/409 163/337 151/348 139/362 180/320 164/336 287/213 250/250 201/299 240/260 280/220 309/191 288/212 238/262`.
The two runs differ by ~15% (the load generator shares the machine), so differences under that are noise: experiment B, which is the second run, showed no gain and was reverted.

## What is known

- A cold page costs ~14 ms end to end when asked one at a time from distinct addresses;
  Server-Timing on cold file pages: `highlight` 0.7-9.6 ms, `render` 5-17 ms, `git` 1-4 ms.
  The one main thread therefore serves ~200-220 a second; the other ~280 a second have
  nowhere to go. Refusing them is what keeps people and the crew fast meanwhile.
- Experiment A shows the budget's "behind" test is not what limits capacity: turning it off
  moved the refusals to the 503 shedder and made the served pages 3x slower. (Caveat: A also
  removed the queue test, so it does not isolate queueing from lateness; it shows only that
  removing the refusal does not add capacity.)

## What a refused stranger is told

`429`, `Retry-After: 60` (the per-address wait; shorter when it is the shared budget), body:

> The forge is busy. Try again in a moment, or sign in to go straight through.

A person can read and act on that. A crawler that does not retry loses that page for the
window; the edge keeps pages across a deploy, so only URLs it does not hold are affected.

## What I do not claim

That refusing is better than rendering off-thread or carrying pages over: neither is
measured. They are #9630 and #9631, each with the same bench as its done-test.
