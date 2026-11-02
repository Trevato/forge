# Backups that cannot lie (#8742)

- **Read from the bucket.** `src/snapshot/bucket.ts` lists the primary and mirror stores every 5 minutes, in the serving process (no CronJob to die). Home's backup tile, vitals (one `backup` card) and the MCP `backups` tool's `verdict` all call `backupVerdict`.
- **Three states.** `green`, `red`, and `unknown`: nothing read yet since boot, or no restore drill yet. Unknown is never a calm tile and never an alarm; only red raises the one `backup` card. A store error is scrubbed of keys and presigned queries before it is kept.
- **Red when:** the newest snapshot is over 26 h old; a lane cannot be read or holds nothing; the newest restore drill failed, did not run, or brought back no rows; or the check itself has not run for 20 min (dead man's switch).
- **Catch-up.** A boot with the newest snapshot older than the last 08:00 UTC slot takes one two minutes later (`snapshotDue`). A snapshot cut short by a release has no manifest, so it counts as lost.
- **In the terminal.** The Resilience dialog (palette: Resilience, admins) opens with the same verdict, each lane's newest, and every reason. On the web it is home's backup tile and `/settings/backups`; for an agent, `verdict` in the MCP `backups` tool.
- **Off the serving thread.** `VACUUM INTO` runs in a worker (`vacuum.ts`).
- **Not done, tracked:** platform/K8s lanes on home (#8805); an off-process probe and snapshots outside the serving process or resumable (#8806). Catch-up retakes a lost snapshot whole.
