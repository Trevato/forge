# Scheduled tools: the forge calls an absorbed app's tool on time

An app can ask the forge to call one of its own declared tools on an interval. No model and no crew is involved: the forge makes the same loopback call the `features` MCP tool makes (`callTool`, `POST /forge/tools/<tool>` with `{"args":{}}`) and keeps how it went.

## Declare it

In the app's `forge.json`, next to the `tools` the schedule names:

```json
"feature": {
  "name": "Radar",
  "tools": { "scan": { "description": "Run a scan now" } },
  "schedule": [{ "tool": "scan", "every": "1h" }]
}
```

- At most 4 entries. `every` is `15m`, `1h`, `6h` or `1d`. A wrong entry is refused with the field named (`src/apps/feature.ts`).
- **Clock time:** `{ "tool": "print_today", "at": "07:15", "tz": "America/Chicago" }` instead of `every` (exactly one of the two; `tz` is an IANA name, daylight saving is followed). It fires once per local day; a forge that was away fires it on its next look within a 3 h grace window and records `late`, and past the window skips the day and records `skipped`. A manual run does not move an `at` schedule (it does move an `every` one). A new or changed schedule first fires at its next due time, never on absorb; Run now is for the impatient. Every way of running a scheduled tool (schedule, page, terminal, the `features` tool) is the one recorded run; a tool the schedule does not name is not recorded.
- Each entry names a tool the feature declares. A tool that is no longer declared is skipped, never called.
- The tool is called with no arguments, so it should be one that needs none.

## When it fires

`src/apps/feature_schedule.ts` looks once a minute (the timer is off under `bun test`). A tool is due when it has never fired or its interval has passed since its last fire, so two looks in one window fire once. The forge calls it only when:

- an admin has absorbed the app (an app that is not absorbed is never called), and
- its production is running. A stopped or asleep app is skipped and never woken; its tool fires on the first look after it is running.

One app at a time, one tool at a time: a slow tool delays the next, and a tool is never called while its previous call is still running. A failing look at one app is logged and does not stop the others.

## What the forge records

One row per (app, tool) in `feature_fire` (`src/core/feature_fires.ts`), replaced on each fire: when it started, whether the app answered `ok`, the error sentence when it did not (`the app answered 500`, a timeout), and how many milliseconds it took. Un-absorbing an app, or deleting it, clears its rows; absorbing again starts from never fired.

## Read it

Every door shows one line per schedule entry, worded once by `scheduleMeta` in `src/apps/feature_schedule.ts`: `scan every 1h · last 10:02, ok · 42 ms · next 11:02`. When the last call failed, its error sentence stands in for `ok`. Before the first call the line reads `scan every 1h · never run · next soon`.

- **Page:** Settings › Features › the app, under **Scheduled** (a site admin's page, as the rest of it). The last run reads as the page's relative clock (`2m ago`) and the next as its day; both carry the exact instant in their tooltip. A failure is in the danger colour. Each row has **Run now**: the same call, recorded as the tool's fire. A stopped or asleep app is refused with a sentence, never woken; a call already running is refused, never doubled.
- **API and the `features` tool:** `GET /api/v1/features/:slug` returns `fires`, a list of `{ tool, at, ok, error, durationMs }` (`at` in ms since the epoch), empty until something has fired. It also returns `schedule`, one `{ tool, every, lastAt, ok, error, durationMs, nextAt, line }` per entry while the app is absorbed. `line` is the plain-text sentence above, with clocks in UTC. Readable by whoever may read the feature.
- **Terminal:** Feature feeds › the app: a `Scheduled:` line above the feed items, the entries' `line`s joined by `; `. An admin presses `r` there to run those tools now: the same call, record and refusal sentences as Run now on the page.

## Not done

No arguments per entry, no history beyond the last fire, and no wake-on-schedule for a stopped app.

## Run history

Each scheduled tool keeps its last 30 runs, with how each started (`schedule`, `late`, `skipped`, `page`, `terminal`, `mcp`), when, whether it went well and how long it took.

- **Features page:** "Run history", one list per tool, the newest 5 shown and the older ones behind "N older".
- **Terminal:** open the feature under Feature feeds and press `h` to switch between the feed and the history; the Scheduled lines above (one per tool, with `at`/zone) stay.
- **API:** `history` in `GET /api/v1/features/:slug`.
