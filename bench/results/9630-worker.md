# Cold code pages rendered off the main thread (#9630)

Command: `bun bench/code-pages-at-rate.ts --rate 500 --seconds 20 --warm 0 --crawl 3000`
(in-process copy, edge bypassed, 3,000 distinct pinned code pages).

| | served | refused (429) | served/s | p95 |
|---|---|---|---|---|
| Baseline (9566-cold-forge.md) | 4,424 | 5,574 | 221 | 827 ms |
| Rows in a worker only | 3,812 | 6,187 | 191 | 943 ms (within noise of baseline) |
| Rows + page encode in workers, run 1 | 6,436 | 3,563 | 322 | 547 ms |
| Rows + page encode in workers, run 2 | 7,015 | 2,984 | 351 | 473 ms |

Highlight + row layout alone moved nothing: on the main thread the brotli/gzip of the ~150 KB page
was the larger share (`codePage+keep` ~4 ms vs `pane` ~1 ms once rows were out). Both now run on two
workers (`src/web/code_rows_pool.ts`); past 64 jobs in flight, or a 5 s timeout, the page does the work inline.
Runs differ ~15% on a shared machine. Refused strangers fall from 5,574 to ~3,000-3,560; still 429.
