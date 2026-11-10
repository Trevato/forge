# Main-thread stalls by route (#9016)

The forge counts every wake of its event loop more than 200 ms late as a
stall, and charges it in full to each route pattern whose request ran across
it (`none` when no request did) — the same reading as the `event loop blocked`
log lines (`src/perf/loop.ts`), so a fix's before and after reads from the
forge itself, not the pod log.

Where to look (a forge admin who is a person; anyone else gets 404, or no
palette entry):

- **`/system`**, the "Main-thread stalls, last hour" card: route, stall ms and
  count for the top 10 routes, most first, plus `/api/v1/telemetry/flow`
  always (0 when it stalled nothing). As of the page's load.
- **`/system`**, inside that card, "Worst single stalls" (#11069), drawn only
  when the hour had one: the five worst single stalls, each with what ran (the route pattern, `job:<name>` for a job
  marked with `jobWatch.during`, or `unknown`), its ms and when. Kept in a
  fixed ring of 256 (`src/perf/stall_blame.ts`).
- **`/healthz`** with `Accept: application/json`: beside `loopLagMs`,
  `loopWorstWhat` names the worst stall of the same 10 s (null when none).
- **The terminal**: `:` → "Main-thread stalls", the same rows, then the same
  worst single stalls (what ran, ms, when in UTC) when the hour had one.
- **`GET /metrics`** (an admin `ro` token): `forge_loop_stall_milliseconds_total`
  and `forge_loop_stalls_total` by `route` since the process started, and the
  last hour as `forge_loop_stall_hour_milliseconds` / `forge_loop_stall_hour_count`
  (docs/METRICS.md lists them).

## Comparing with #8978

#8978 measured `/api/v1/telemetry/flow` holding the thread 69.6 s in 6
minutes (2026-11-02, 0.7.349): about 11.6 s a minute, or roughly 700,000 ms
an hour at that rate. The `/api/v1/telemetry/flow` row on `/system` is that
figure for the last hour; for the same 6-minute window,
`increase(forge_loop_stall_milliseconds_total{route="/api/v1/telemetry/flow"}[6m])`
in Prometheus, compared with 69,600.

Caveats: a stall over two requests counts against both, so routes sum past
the wall time; a request still running when the wake comes is not yet named;
a restart starts the figures at zero.
