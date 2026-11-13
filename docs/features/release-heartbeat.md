# Release heartbeat and the main-ahead alarm (#11507)

The release tick records a heartbeat each time it runs (`src/keeper/beat.ts`, table `keeper_beat_tick`): when, whether it cut, skipped or failed, and why. The last 50 are kept (`KEPT`); each new one drops the oldest beyond that, and every reader shows the newest (#11794). The outcome is the keeper's own (`tickStep` in `src/keeper/keeper.ts` says it where it decides), never read back from the line's words; a tick that throws is recorded as failed (`stepWithBeat`). None for 60 minutes is said plainly ("No heartbeat from the release tick for …").

Where to see it:

- `/releases`, in the release keeper section: the last heartbeat (`#keeper-heartbeat`) and, while main is green and ahead of production, how far and for how long (`#keeper-ahead`).
- The terminal: the palette's **Release keeper** screen, gated as /releases is, shows the same two lines under what holds the next cut.
- `release_keeper` (MCP) and `GET /api/v1/keeper`: `heartbeat` (at, outcome, reason, silent, says).

The flow alarm `main_ahead` (`src/flow/alarm_main_ahead.ts`) fires when main's last finished check passed, its head is not the commit production runs, and main has been ahead for more than 90 minutes. Change the limit with the `release.ahead_minutes` row of `forge_setting` (a whole number, 1 to 10080; anything else is 90). It names production's version and commit, the commits and pulls ahead, how long, and when the tick was last heard from. It is an ask for the owner (home) and one Sentinel issue (`src/crew/sentinel_main_ahead.ts`), which closes itself at the next hunt after production catches up, unless a person commented on it. The issue names the tick's last outcome and time, never its reason: the issue may be public, and the reason is shown only to readers of /releases.

The flow alarm `release_quiet` (`src/flow/alarm_release_quiet.ts`, #11890) fires when the release tick has not beaten for more than 60 minutes (`SILENT_MS`), so production could fall behind main with nothing deciding to release. It says how long ago the tick was last heard and its outcome, never its reason, for the same cause as the issue above: the alarm reaches home, /boards, the notifier and the MCP `flow` tool, and links to /releases, where the reason is. A forge that has never had a beat but has cut a release fires it too, counted from the newest cut; one that has never released stays quiet. The next beat, of any outcome, clears it.

`/api/v1/telemetry/home`: `live` is the version and commit this process runs (null when unstamped); `main` is the head of the forge's own default branch and `behind` what main holds that live does not (#11676).

## Recording a tick from outside (#11674)

A release path that runs outside the forge (a workflow, a script) leaves the same heartbeat: it adds a row, and the oldest beyond 50 goes:

```sh
curl -X POST "$FORGE_URL/api/v1/release/heartbeat" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"outcome":"skipped","reason":"main has not moved"}'
```

It needs a token with the `admin` scope belonging to a site administrator (401 without a token, 403 otherwise). `outcome` is `cut`, `skipped` or `failed`; `reason` is 1 to 300 characters with no control characters (422 otherwise). The answer is the recorded beat, `201`.

## A release is proven by a stranger's journey

After the usual smoke of the public URL, the proof walks a stranger's journey against it (`walkJourney`, `src/release/journey.ts`): a new forge, claimed, and the crew's first activity, cleaning up after itself. The walk runs last. If it fails, the release stays unproven: the proof is red with "a stranger's journey failed: …" as its sentence, and it is retried on the same `retryAfter` backoff as any failed proof. A walk failure does not set `slow` or `gaveUp`, so a walk that hangs gets the plain doubling, not the shorter polls of a late swap.

When the proof passes it keeps the two timings (`journey.readyMs`, `journey.firstActivityMs`). `/releases` (`#journey-proof`) and the terminal's releases screen then say "a stranger's forge was ready in N s and the crew working in M s". The line shows only for a passing proof of the version being served, with both timings, and only to those who may read /releases; an older proof without timings shows nothing.
