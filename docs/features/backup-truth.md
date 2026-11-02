# Backups that cannot lie (#8742)

- **Read from the bucket.** `src/snapshot/bucket.ts` lists the primary and mirror stores every 5 minutes, in the serving process (no CronJob to die). Home's backup tile, vitals (one `backup` card) and the MCP `backups` tool's `verdict` all call `backupVerdict`.
- **Three states.** `green`, `red`, and `unknown`: nothing read yet since boot, or no restore drill yet. Unknown is never a calm tile and never an alarm; only red raises the one `backup` card. A store error is scrubbed of keys and presigned queries before it is kept.
- **Red when:** the newest snapshot is over 26 h old; a lane cannot be read or holds nothing; the newest restore drill failed, did not run, or brought back no rows; or the check itself has not run for 20 min (dead man's switch).
- **Catch-up.** A boot with the newest snapshot older than the last 08:00 UTC slot takes one two minutes later (`snapshotDue`). A snapshot cut short by a release has no manifest, so it counts as lost.
- **In the terminal.** The Resilience dialog (palette: Resilience, admins) opens with the same verdict, each lane's newest, and every reason. On the web it is home's backup tile and `/settings/backups`; for an agent, `verdict` in the MCP `backups` tool.
- **Off the serving thread.** `VACUUM INTO` runs in a worker (`vacuum.ts`).
- **Not done, tracked:** platform/K8s lanes on home (#8805); snapshots outside the serving process or resumable (#8828; the off-process probe is below). Catch-up retakes a lost snapshot whole.

## The probe outside the forge (#8806, part 1)

The in-process bucket check dies with the forge, so a dead forge looked like
a quiet one. `scripts/backup-probe.ts` is a separate process (run it from cron
or another host) that reads the forge and the bucket and goes red when either
is silent.

```
S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… \
  bun scripts/backup-probe.ts --forge https://your.forge [--max-age-hours 36]
bun scripts/backup-probe.ts --forge http://127.0.0.1:3000 --dir /path/to/backups
```

Exit 0 when green; exit 1 and a `RED` line per failing read otherwise. Red is:
`/healthz` unanswered or not 200 within 10 s; no store configured; the store
unreadable or empty; or the newest manifest's `finishedAt` older than the
limit (default 36 h: one nightly plus grace). Use read-only credentials.
Logic lives in `src/snapshot/probe.ts`; tests in `test/backup-probe.test.ts`.

### Not done yet

Snapshots are still taken inside the serving process; a release mid-snapshot
is caught up by retaking it whole after boot. Resuming across a release (or
moving the snapshot into its own process) is a separate, larger change, tracked in #8828.
