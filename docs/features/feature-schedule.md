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

- **Page:** Settings › Features › the app, under **Scheduled** (a site admin's page, as the rest of it).
- **API:** `GET /api/v1/features/:slug` returns `fires`: a list of `{ tool, at, ok, error, durationMs }` (`at` in ms since the epoch). It is empty until something has fired. Readable by whoever may read the feature.
- **Terminal:** Feature feeds › the app: a `Scheduled:` line above the feed items, tool, outcome and age.

## Not done

No arguments per entry, no history beyond the last fire, no "run now" button, and no wake-on-schedule for a stopped app.
