# Actions that answer at once (#8708)

A form marked `data-now` shows its result in the frame it is submitted in, posts in the background asking for JSON, and rolls back with the server's reason when it is refused. No client model: the page is still what the server rendered, and live regions bring the rest. Without script the form posts and redirects as before.

- Script: `src/web/act_now.ts`, appended to `shellJs` (`client.ts`), so it is cached with the shell. Byte budget `ACT_NOW_BUDGET`, held by `test/act-now.test.ts`.
- Opted in: assign, labels, close/reopen (thread, pull, "done on main"), flow first (the rerank), approve a proposal.
- The handlers answer `{ ok, flash }` or 422 `{ ok: false, error }` when `accept: application/json` (`flashOrJson`).
- Streams: every live-region frame carries the event's id (`id:`); a reconnect with `Last-Event-ID` (or `?since=`) replays only what came after, oldest first (`http/sse.ts`).

## Perceived action time

Measured in-process on loopback (median of 40, flow toggle): before, POST + 303 + GET of the page = 17.1 ms of server work, and on a real network that is two round trips. After, the result is painted in the same task as the submit (one frame, <= 16.7 ms at 60 Hz) and the confirmation costs one JSON POST = 3.5 ms of server work, off the critical path.
