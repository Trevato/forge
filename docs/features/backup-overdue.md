# An overdue off-box backup (#10924)

When the newest copy of the forge that left the machine is more than 26 hours old (a nightly plus two hours), `flow/alarm_backup.ts` fires the `backup` flow alarm. It reads two small files under the data directory (the snapshot outcome and the mirror's record), never the network, and says one sentence: how old the newest off-box backup is, or that none has landed, and the last failure's cause. A forge that has never sent a copy off the box and never failed to is not alarmed.

- **On the web.** `/flow` (a forge admin) leads with one row: that sentence and **Retry the backup now** (`POST /flow/backup/retry`). Home and /boards draw it as a line like the other flow alarms; their cache is keyed on the backup's state, so a cleared backup leaves Home at once.
- **In the terminal.** The palette's **Valves** (a forge admin who is a person) shows the same sentence on its first line, with `b` to retry. The Flow dialog and the dashboard carry it in their alarm lines.
- **One retry.** Both doors call `actions/backup_retry.ts`, which takes one snapshot through `snapshotNow` (the service's own queue, so two never run at once).
- **Honest about where it landed.** The alarm clears only when a copy is off the machine. A snapshot that landed in a local directory is said to have "stayed on this machine, so it is not an off-box backup"; the card stays while an older off-box copy is the newest.
- **Callers.** `firedAlarms` takes `dataDir` as a required option (`null` for a unit over a bare db), so a door cannot silently lose the alarm.

Tests: `test/alarm-backup.test.ts`, `test/backup-retry.test.ts` (a real snapshot into a directory; the Valves screen).
