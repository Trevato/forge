# Whose wait it was: the forge's or the app's (#10858)

An app's production speed card says the slowest wait the forge relayed to it in the last 10 minutes, and whether the forge or the app spent it. When the forge's own event-loop lag (`forge-lag`) is more than half the time to the app's headers (`forge-ttfb`), the wait is the forge's (`forgeWaited`, `src/perf/loop_worst.ts`), and the card says so instead of calling the app slow.

- Page: Settings → App → **Visitors and speed**, a **Slowest wait, 10 min** row beside the p75 figures: `the forge was busy: 600 ms of the 820 ms wait, held by job:sweep-runs (600 ms)`, or `820 ms, the app's own`. No row when nothing was relayed in the window.
- Terminal: the deploys screen's visitors line ends `· slowest wait, 10 min: the forge was busy: 600 ms of the 820 ms wait, held by job:sweep-runs (600 ms)`.
- API: `GET /api/v1/repos/:owner/:name/app`, for the app's admins, carries `vitals.wait: {ttfbMs, lagMs, at, forge, held}`; absent with no wait in the window. `held` is `[{name, ms}]`, empty unless `forge`.

## What held it (#11000)

When the wait was the forge's, the forge names what blocked its loop in the lag's 10 s window: the stalls the loop watch (`src/perf/loop.ts`) noted, each by the route patterns that ran across it, else the background jobs as `job:<name>`. Longest stall first, each name once, at most three. A name is only ever a pattern — a path pattern such as `/:owner/:name`, `job:<name>` or `(unmatched)` — never a path's ids or query (`isStallPattern`, `src/apps/relay_wait.ts`); a stall nothing named ran across is left out. The card and terminal line add `, held by <name> (<ms>)…`; no `held by` when the wait was the app's own.

A signed-in forge admin (active, not an agent) also gets the names on the relayed answer itself, beside `forge-lag`: `Server-Timing: forge-stall;desc="job:sweep-runs";dur=600.0`, one entry per name. That copy is sent `cache-control: private, no-store` (and without `etag`), so no shared cache keeps the forge's route names; visitors and everyone else never get `forge-stall`.

Production only; previews are not counted. Held in the forge's memory (at most 2,000 apps), so a restart forgets it.

Try it: hold a production app's answer behind a busy forge (a long synchronous task on the forge, then load the app), then open its repository's Settings → App within 10 minutes. Signed in as a forge admin, the app's own response carries `forge-stall` too.
