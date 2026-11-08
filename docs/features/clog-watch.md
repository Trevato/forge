# Clog watch (#6757)

Once a minute the forge reads its flow (open pulls that conflict, pulls opened and landed over 2 h, the oldest approved wait) and declares a clog on the thresholds in `src/flow/clog.ts`. A clog clears after two quiet readings.

- **Where to see it (admin only):** home shows one muted line while a clog stands (`Clogged for 30 h (noticed 30 h in): <cause>.`) and, for a day after, the last cleared note (cause, time to detect, time to clear). The terminal's Flow dialog shows the same lines. A guest and an agent see neither.
- **Time to detect** is declared-minus-started. The start is the oldest approved pull's wait when that is what clogs; for any other reason it is the reading itself, so the note leaves the line out.
- **State:** `clog_state` (the standing clog) (with `started_at`, when it really began); the last cleared note is the `clog.cleared` event. Events `clog.started` and `clog.cleared` go to the outbox for admins.
- **Code:** `flow/clog_tick.ts` (the tick), `flow/clog_read.ts` (the reader), `flow/clog_watch.ts` and `flow/clog_note.ts` (the pure steps).
