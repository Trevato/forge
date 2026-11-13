# How long the event log keeps what it holds

`event` is the forge's log of what happened. `src/system/retention_events.ts` says which kinds are state read back at any age and are never trimmed: `issue.*`, `pull.*`, `repo.*`, `user.*`, `push`, `app.egress.*`, `keeper_*` and a few marks. Every other kind is trimmed once it is older than `retention.event_days` (#12008, #12052).

## The window

The default is 30 days (`KEEP_DAYS`). That is the longest fixed window any page or tool asks of a kind that is not kept: a board's `30d` range. The home feed, the digest and the affinity weights read a week or less. The events page, the events API, the MCP `events` tool, the Atom feed and SSE replay page back through the log, so for unkept kinds they answer the window and nothing older.

It was 180 days. On a forge younger than that, which production is (it started 2026-08-03), the rule trimmed nothing while `event` held 578 MB of a 4.6 GiB file.

An admin moves the window on `/admin/limits` (**Days the event log keeps what no page reads at any age**), from 7 to 3,650 days. The next slice reads the new value.

## Wake-ups live hours, not days

Three kinds exist to wake what is listening as they are appended and say nothing worth listing afterwards: `run.shard` (a check's shard finished: the pull's checks line patches itself), `usage.delta` (the spend graph redraws) and `backup.progress` (a progress bar moves). `run.shard` alone was 57% of the log's rows on production (1.38M of 2.40M), and every row costs ten index entries, about 700 bytes in all. They are kept `LIVE_KEEP_MS` (6 hours: a page that reconnects inside it still replays what it missed) and not 30 days (`pruneLiveEvents`, `LIVE_KINDS`). A new kind that only wakes a listener joins that list; a kind someone reads later does not.

## How it trims

`src/system/retention.ts` runs two jobs, `retention-events` (the age rule) and `retention-live` (the wake-ups), as paced slices: the age rule walks 300 rows from where the last slice stopped, oldest first, and deletes those past the window; the wake-up rule reads each kind's oldest rows through the (kind, seq) index and deletes the old ones, at most 400 in one transaction. After a slice of `t` ms a job waits `19 t` (never under 100 ms), so each takes 5% of the thread at most; with nothing left it looks again in 15 seconds. When the age rule's pass reaches rows inside the window, it waits a day before starting again. A webhook delivery that is still pending keeps its event.
