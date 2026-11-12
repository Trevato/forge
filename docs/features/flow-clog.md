# /flow: what is clogging the lane (#11454)

The owner's `/flow` opens with these rows, no box (`src/web/pages/flow-clog.ts`, mounted by one line in `flow.ts`; read by `src/flow/clog_view.ts`):

- **One sentence** from `clogSays`: the standing clog's reasons, approved pulls that conflict, the file most open pulls touch, and the dollars waiting to land.
- **One test, many pulls** from `sharedRed`: a test failing in the latest check of three or more open pulls is listed once, with each pull linked.
- **Pulls on the same files** from `conflictPairs`: at most 20 pairs, each linked to both pulls.

Nothing is read from git per request: pull file lists come from the memory `crew/hot_files.ts` already keeps, the rest from the runs, reviews and pulls tables. A quiet lane draws nothing. Admin only, like the rest of `/flow`. The terminal's Flow dialog (`src/tui/screens/flow.ts`) shows the same sentence and rows as lines.

Not done: before/after looks are captured by the forge from the preview, not made here.
