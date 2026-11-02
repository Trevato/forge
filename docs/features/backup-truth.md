# Backups that cannot lie (#8742)

- **Read from the bucket.** `src/snapshot/bucket.ts` lists the primary and mirror stores every 5 minutes, in the serving process (no CronJob to die). Home's backup tile, vitals (one `backup` card) and the MCP `backups` tool's `verdict` all call `backupVerdict`.
- **Three states.** `green`, `red`, and `unknown`: nothing read yet since boot, or no restore drill yet. Unknown is never a calm tile and never an alarm; only red raises the one `backup` card. A store error is scrubbed of keys and presigned queries before it is kept.
- **Red when:** the newest snapshot is over 26 h old; a lane cannot be read or holds nothing; the newest restore drill failed, did not run, or brought back no rows; or the check itself has not run for 20 min (dead man's switch).
- **Catch-up.** A boot with the newest snapshot older than the last 08:00 UTC slot takes one two minutes later (`snapshotDue`). A snapshot cut short by a release has no manifest, so it counts as lost.
- **In the terminal.** The Resilience dialog (palette: Resilience, admins) opens with the same verdict, each lane's newest, and every reason. On the web it is home's backup tile and `/settings/backups`; for an agent, `verdict` in the MCP `backups` tool.
- **Off the serving thread.** `VACUUM INTO` runs in a worker (`vacuum.ts`).
- **Not done, tracked:** snapshots outside the serving process or resumable (#8828; the off-process probe is below). Catch-up retakes a lost snapshot whole.

## Platform backup lanes (#8811)

Every other place a backup lands — one per CronJob in the `backup` namespace —
is a lane the platform declares in `FORGE_BACKUP_LANES`, a JSON list kept in
the forge's configuration, never in this repository:

```json
[{ "name": "backup/postgres", "endpoint": "https://s3.example.com", "bucket": "platform-backups",
   "prefix": "postgres/", "region": "us-east-1", "accessKey": "…", "secretKey": "…" }]
```

- **List-only keys.** `src/snapshot/lanes.ts` only lists; give each lane keys
  that can do nothing else.
- **Read on the watch's clock.** Each pass reads every lane beside `primary` and
  `mirror`, and the verdict names each one's newest object, size and age.
- **Bounded, never a full listing.** One delimited listing per folder level (at
  most three pages of 1,000), walking only into the folder whose name sorts
  last, since backup names carry their date. A level wider than that is read
  in part: a fresh object found still proves the lane fresh; a stale one, or
  none, is red and says to name a narrower prefix.
- **Red when:** the store does not answer within 10 s, nothing is under the
  prefix, or the newest object is over 26 h old. A lane the configuration
  names but that does not read whole is red with what is wrong, never with its
  values.
- **Nothing unsafe printed.** Errors are scrubbed of keys, and every key or
  error the store wrote has its control bytes replaced with `?` before it
  reaches a terminal or an MCP client.
- **Where to see it.** MCP `backups` → `verdict.lanes`; the terminal's
  Resilience dialog; home's backup tile reads the same verdict.

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
