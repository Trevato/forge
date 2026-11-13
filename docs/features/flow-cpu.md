# /flow: pulls closed unmerged after a CPU stop (#11904)

A check the cell's watch stopped for CPU failed for the machine's reasons, not the pull's. When such a pull was closed without merging, it is worth queuing again. `/flow` lists those pulls so a person can find them.

## What it shows

- **The hour's CPU stops:** "3 checks stopped for CPU in the last hour." (`cpuStops`, `src/flow/cpu_stops.ts`).
- **Closed unmerged after a CPU stop:** the pulls whose last check, not counting the retry cancelled by the close, was a CPU stop (`isCpuStop`) in the last 7 days. The pull must be closed and unmerged now. They are listed newest close first, at most 20 (`cpuClosedPulls`, `src/flow/cpu_closed.ts`).

When there are no stops and no pulls, nothing is shown.

## Where to read it

- **Page:** `/flow`, under the clog rows (`src/web/pages/flow-cpu.ts`): one count line, then one `row()` per pull in a `.list` (its link and when it closed), no box and no new class. Each row links to the pull's page, where it can be reopened. Admin only, like the rest of `/flow`.
- **Terminal:** the Flow command (palette, admins). The same count, then one line per pull (`src/tui/screens/flow_cpu.ts`).
- **Agents:** the `flow` MCP tool with `{ kind: "cpu" }` returns `{ stopped, closed: [{ repo, number, closedAt }] }`. An admin person sees every repository. Anyone else sees public repositories only, with `stopped` at 0.

It is one indexed query on `run_kind_finished`, with nothing read from git. The CPU test (`CPU_STOP_SUMMARY` for a cancelled check, `CPU_RED_LIKE` for a red one) and the cap of 20 are both in the SQL, so a load reads at most 20 rows.
