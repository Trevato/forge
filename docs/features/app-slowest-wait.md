# Whose wait it was: the forge's or the app's (#10858)

An app's production speed card says the slowest wait the forge relayed to it in the last 10 minutes, and whether the forge or the app spent it. When the forge's own event-loop lag (`forge-lag`) is more than half the time to the app's headers (`forge-ttfb`), the wait is the forge's (`forgeWaited`, `src/perf/loop_worst.ts`), and the card says so instead of calling the app slow.

- Page: Settings → App → **Visitors and speed**, a **Slowest wait, 10 min** row beside the p75 figures: `the forge was busy: 600 ms of the 820 ms wait`, or `820 ms, the app's own`. No row when nothing was relayed in the window.
- Terminal: the deploys screen's visitors line ends `· slowest wait, 10 min: the forge was busy: 600 ms of the 820 ms wait`.
- API: `GET /api/v1/repos/:owner/:name/app`, for the app's admins, carries `vitals.wait: {ttfbMs, lagMs, at, forge}`; absent with no wait in the window.

Production only; previews are not counted. Held in the forge's memory (at most 2,000 apps), so a restart forgets it.

Try it: hold a production app's answer behind a busy forge (a long synchronous task on the forge, then load the app), then open its repository's Settings → App within 10 minutes.
