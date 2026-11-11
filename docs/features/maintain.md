# Maintenance duties (#11204)

A duty is one file in `src/maintain/duties/`: a `name`, an `intervalMs` and a `run` that returns `findings` and `actions`. Register it with one line in `src/maintain/registry.ts`.

Every minute the runner (`src/maintain/runner.ts`, inside `during("maintain")`) runs each duty whose interval has passed since it last started, never two runs of one duty at once, and writes a `maintenance_run` row: duty, started, finished, findings, actions, probes, outcome.

A finding must carry a probe: `{ kind: "query" | "measurement", what, number, at }`. A finding without one is refused: the run keeps no findings or actions and its outcome reads `refused: finding "…" has no probe`. A duty that throws reads `failed: <message>`.

`GET /api/v1/maintenance/runs?limit=20` (forge admin, `ro` scope) lists the latest rows. The shipped duty, `pulls-waiting`, counts open pulls older than 24 hours.

The terminal door is the palette entry "Maintenance duty runs" (`src/tui/screens/maintainruns.ts`): the same rows through the same read, offered only to a forge admin; anyone else is offered nothing and sees no rows.

Each run is bounded: a duty that has not answered in 30 seconds reads `failed: timed out` and the next duty runs (the late duty keeps its slot until it settles, so it never overlaps itself). A duty name must be lowercase words and dashes and unique, or the runner refuses to start. Each duty keeps its newest 200 rows; older ones are deleted after each run. A finding that says nothing reads `refused: a finding says nothing`. A non-admin's token reads 403 `forbidden`.
