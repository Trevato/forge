# Maintenance duties (#11204)

A duty is one file in `src/maintain/duties/`: a `name`, an `intervalMs` and a `run` that returns `findings` and `actions`. Register it with one line in `src/maintain/registry.ts`.

Every minute the runner (`src/maintain/runner.ts`, inside `during("maintain")`) runs each duty whose interval has passed since it last started, never two runs of one duty at once, and writes a `maintenance_run` row: duty, started, finished, findings, actions, probes, outcome.

A finding must carry a probe: `{ kind: "query" | "measurement", what, number, at }`. A finding without one is refused: the run keeps no findings or actions and its outcome reads `refused: finding "…" has no probe`. A duty that throws reads `failed: <message>`.

`GET /api/v1/maintenance/runs?limit=20` (forge admin, `ro` scope) lists the latest rows. The shipped duty, `pulls-waiting`, counts open pulls older than 24 hours.

The terminal door is the palette entry "Maintenance duty runs" (`src/tui/screens/maintainruns.ts`): the same rows through the same read, offered only to a forge admin; anyone else is offered nothing and sees no rows.

Each run is bounded: a duty that has not answered in 30 seconds reads `failed: timed out` and the next duty runs (the late duty keeps its slot until it settles, so it never overlaps itself). A duty name must be lowercase words and dashes and unique, or the runner refuses to start. Each duty keeps its newest 200 rows; older ones are deleted after each run. A finding that says nothing reads `refused: a finding says nothing`. A non-admin's token reads 403 `forbidden`.

## efficiency-watcher (#7558)

Hourly, the duty records what each cost read (`efficiency_sample`, one row per cause per hour) and judges it (`src/efficiency/`):

- **Causes** (`causes.ts`): npm registry bytes received, bytes from every other destination (image pulls, git fetch and clone, apps), the machine's CPU-seconds, and the install cache hit rate. Each has a floor and, for the byte causes, an absolute ceiling. The hit rate is the share of the hour's contained installs (`meteredInstall`, counted in `installs.ts`, in memory) that fetched under 1 MiB from the registry (`NPM_MISS_BYTES`); under 5 installs in the hour there is no reading. It is a *falling* cause: its floor is on the baseline (a baseline under 50% is not fallen from). Not measured by cause: per-run bytes and peak memory, which have no counter to read yet.
- **Baseline** (`baseline.ts`): the median of the same hour of the day over the last 7 days; under 3 days of history there is none, so a new forge files nothing by doubling.
- **Files when** (`judge.ts`) an hour is at least 2x its baseline for 2 hours running (a hit rate: at most half its baseline for 2 hours running), or at or over the ceiling. The reading is the rolling last hour of the egress tally, taken when the duty runs.
- **One issue per cause** on the forge's repository (`FORGE_REPO`, as its owner): the cause, the number, the baseline and the code path. A comment each hour it still stands; closed with a note once the cost has been back under for 24 hours. If a person closes it, the next finding opens a new one.
- The series is the `efficiency` board source (admin boards), so a board can chart it.
- **Where an admin sees it.** The run is a row on the admin's "Maintenance duty runs" screen (terminal palette; `GET /api/v1/maintenance/runs`) under `efficiency-watcher`, with each finding's probe. The hourly series is the `efficiency` source on /boards (filter `cause`, value `value`; the hit rate is 0..1). If `FORGE_REPO` is unset or names no repository, findings still show on the run and its actions say `filed nothing: <why>`.
