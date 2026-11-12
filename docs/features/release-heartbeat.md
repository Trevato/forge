# Release heartbeat and the main-ahead alarm (#11507)

The release tick records a heartbeat each time it runs (`src/keeper/beat.ts`, table `keeper_beat`): when, whether it cut, skipped or failed, and why. The outcome is the keeper's own (`tickStep` in `src/keeper/keeper.ts` says it where it decides), never read back from the line's words; a tick that throws is recorded as failed (`stepWithBeat`). None for 60 minutes is said plainly ("No heartbeat from the release tick for …").

Where to see it:

- `/releases`, in the release keeper section: the last heartbeat (`#keeper-heartbeat`) and, while main is green and ahead of production, how far and for how long (`#keeper-ahead`).
- The terminal: the palette's **Release keeper** screen, gated as /releases is, shows the same two lines under what holds the next cut.
- `release_keeper` (MCP) and `GET /api/v1/keeper`: `heartbeat` (at, outcome, reason, silent, says).

The flow alarm `main_ahead` (`src/flow/alarm_main_ahead.ts`) fires when main's last finished check passed, its head is not the commit production runs, and main has been ahead for more than 90 minutes. Change the limit with the `release.ahead_minutes` row of `forge_setting` (a whole number, 1 to 10080; anything else is 90). It names production's version and commit, the commits and pulls ahead, how long, and when the tick was last heard from. It is an ask for the owner (home) and one Sentinel issue (`src/crew/sentinel_main_ahead.ts`), which closes itself at the next hunt after production catches up, unless a person commented on it. The issue names the tick's last outcome and time, never its reason: the issue may be public, and the reason is shown only to readers of /releases.

`/api/v1/telemetry/home`: `live` is the version and commit this process runs (null when unstamped); `main` is the head of the forge's own default branch and `behind` what main holds that live does not (#11676).

## Recording a tick from outside (#11674)

A release path that runs outside the forge (a workflow, a script) leaves the same heartbeat, replacing the last one:

```sh
curl -X POST "$FORGE_URL/api/v1/release/heartbeat" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"outcome":"skipped","reason":"main has not moved"}'
```

It needs a token with the `admin` scope belonging to a site administrator (401 without a token, 403 otherwise). `outcome` is `cut`, `skipped` or `failed`; `reason` is 1 to 300 characters with no control characters (422 otherwise). The answer is the recorded beat, `201`.
