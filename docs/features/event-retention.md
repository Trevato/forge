# How long the event log keeps what it holds

`event` is the forge's log of what happened. `src/system/retention_events.ts` says which kinds are state read back at any age and are never trimmed: `issue.*`, `pull.*`, `repo.*`, `user.*`, `push`, `app.egress.*`, `keeper_*` and a few marks. Every other kind is trimmed once it is older than `retention.event_days` (#12008, #12052).

## The window

The default is 30 days (`KEEP_DAYS`). That is the longest fixed window any page or tool asks of a kind that is not kept: a board's `30d` range. The home feed, the digest and the affinity weights read a week or less. The events page, the events API, the MCP `events` tool, the Atom feed and SSE replay page back through the log, so for unkept kinds they answer the window and nothing older.

It was 180 days. On a forge younger than that, which production is (it started 2026-08-03), the rule trimmed nothing while `event` held 578 MB of a 4.6 GiB file.

An admin moves the window on `/admin/limits` (**Days the event log keeps what no page reads at any age**), from 7 to 3,650 days. The sampler's next 15-second tick reads the new value.

## How it trims

The sampler's tick deletes at most 1,000 rows, a chunk of 1,000 per transaction, oldest first. When a pass reaches rows inside the window, it waits a day before starting again. A webhook delivery that is still pending keeps its event.
