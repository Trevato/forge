# Pages over budget (real visitors)

The page beacon's reports (`page_vital`) roll up per route pattern over the last hour: p95 time to first byte (server) and p95 largest paint. A page with at least 10 reports that misses `PAGE_BUDGET` (`src/perf/budgets.ts`: server 150 ms, first paint 1 s) gets one line on `/system` ("Pages over budget, last hour") and in the terminal's "Pages over budget" screen, naming the slowest part: the server, or the browser drawing it (first byte to first paint). When every page is fast nothing is shown: no section, no palette entry. Code: `slowPages` in `src/perf/watch.ts`.

The look is bounded: at most 50 routes, the newest 500 reports of each, and `/system` keeps the result 5 seconds. The section is not live; it changes on reload.
