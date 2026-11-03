# Backups that cannot lie (#8742)

- **Read from the bucket.** `src/snapshot/bucket.ts` lists the primary and mirror stores every 5 minutes, in the serving process (no CronJob to die). Home's backup tile, vitals (one `backup` card) and the MCP `backups` tool's `verdict` all call `backupVerdict`.
- **Three states.** `green`, `red`, and `unknown`: nothing read yet since boot, or no restore drill yet. Unknown is never a calm tile and never an alarm; only red raises the one `backup` card. A store error is scrubbed of keys and presigned queries before it is kept.
- **Red when:** the newest snapshot is over 26 h old; a lane cannot be read or holds nothing; the newest restore drill failed, did not run, or brought back no rows; or the check itself has not run for 20 min (dead man's switch). The reason says when it last ran: `The backup check has not run for 25 min (last ran 2026-11-02T08:00:00Z); it is the alarm, and it is down.`
- **The run record.** Every run of the check appends one JSON line (`at`, and each lane's `ok` and `newestAt`) to `backup-checks.jsonl` under the data directory. The count is kept in memory; once the file holds 400 runs it is cut back to the last 200. A disk that refuses the write never stops the check. The verdict carries `runs` and `checkLine` (`The backup check last ran <ISO> (3 min ago); 42 runs on record.`), shown in the Resilience dialog, the home tile's title and the `backup` card, so a person can see the check is alive.
- **Catch-up.** A boot with the newest snapshot older than the last 08:00 UTC slot takes one two minutes later (`snapshotDue`). A snapshot cut short by a release has no manifest, so it counts as lost.
- **In the terminal.** The Resilience dialog (palette: Resilience, admins) opens with the same verdict, each lane's newest, and every reason. On the web it is home's backup tile and `/settings/backups`; for an agent, `verdict` in the MCP `backups` tool.
- **Off the serving thread.** `VACUUM INTO` runs in a worker (`vacuum.ts`).
- **Not done, tracked:** snapshots outside the serving process (#8828); resuming across a release is below, and so is the off-process probe.

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

## Resuming across a release (#8828)

A snapshot cut short has no manifest, but it is no longer retaken whole.
`takeSnapshot` writes `partial.json` under the snapshot's prefix (after the
first landed object, every 100 more, every 15 s while something new landed,
and on failure; a release kills the process without running any cleanup, so
the clock is what leaves it): the repository bundles and run bundles that
landed, with their sizes and SHA-256 digests. The catch-up after boot (`takeIfDue`) finds the
newest prefix newer than the newest manifest, begun within 24 h, that holds a
journal, and takes the snapshot again under that name and start time with
`resume`. A bundle or run bundle the journal lists with the same size and digest is
not put again; the database, key, ssh files, app data and recent run logs always are,
since they change while the forge runs. The journal is deleted once the
manifest is written. `pruneSnapshots` removes a prefix with no manifest that
is older than the newest whole snapshot or past the window.

Not done: the snapshot still runs in the serving process (the database copy is
in a worker). Tests: `test/snapshot-resume.test.ts`.
