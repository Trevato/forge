# A failed adapter pull speaks once in the writers' feed (#10135)

When an app's adapter pull turns from ok (or from nothing) to failed, the
forge appends one `adapter.sync_failed` event: "<owner>/<repo> sync failed:
<reason>", linking to the app page. Repeated failures and recoveries append
nothing, so a broken source says it once, not on every pull.

- **Who sees it:** the `writers` audience (`src/core/event_audience.ts`): those
  who may write the repository (`canWrite`). Readers and signed-out visitors
  see nothing.
- **Where:** the home feed on the web, and the terminal's feed screen
  (`src/tui/screens/feed.ts`). Both call `readFeed`, which reads
  `candidatesFor` and its audience filter, so the two doors agree
  (`test/feed-sync-failed.test.ts` checks both).
- **Reason:** stored cut to 200 characters (`PULL_REASON_MAX`), shown cut to
  120 in the line.
- **Timing:** the event is appended after the run's transaction commits, so a
  live viewer never hears of a pull that was rolled back.
