# An app's encrypted backup, with a restore proof (#11701)

The forge's backup (`backup-truth.md`) covers the forge. An app's data
(`FORGE_APP_DATA`: its SQLite files and uploads) gets a backup the **owner**
holds the key to, and a restore that proves itself.

```
export APP_BACKUP_PASSPHRASE='…at least 12 characters, kept off the forge…'
bun scripts/app-backup.ts seal <data-dir> <out-file>
bun scripts/app-backup.ts prove <out-file> <empty-scratch-dir>
```

- `seal` checkpoints every SQLite file, archives the directory, encrypts it
  (AES-256-GCM, key = scrypt of the passphrase, header authenticated) and
  writes `<out-file>` with mode 0600. It then restores the file into a scratch
  directory of its own and prints `PROVEN: <files>, <bytes>, <tables>, <rows>`,
  exit 0, or `RED` and each mismatch, exit 1. Delete nothing on the old side
  until it says PROVEN.
- The proof reads back from disk every file's size and SHA-256, and every
  SQLite table's row count, against the manifest taken at backup time
  (the step-3 and step-5 comparison in `platform-app-move.md`).
- The seal is only kept when it is clean. It is written under a temporary
  name beside `<out-file>` and renamed on PROVEN; a RED proof leaves nothing.
  An out-file inside the data directory is refused.
- The proof covers the data left behind too: after sealing, the data
  directory is read again against the manifest, and a file that changed,
  appeared or vanished since the read is RED. Entries the walk cannot
  archive (symlinks, sockets, devices) are listed in the manifest (`skipped`)
  and in the output, and make the proof RED: the backup does not cover them.
  `-wal` and `-shm` files are not archived; the checkpoint empties them.
- A wrong passphrase and a damaged or truncated file are refused alike, before
  anything is written. The passphrase is only ever read from the environment
  (script) or typed masked (terminal); the forge never stores or logs it.

## In the terminal

An admin of an app opens `:` → "Back up data" (`src/tui/screens/appbackup.ts`).
`s` asks for the passphrase (masked) and seals the app's production data into
`<forge data>/app-backups/<app id>/production-<time>.fab`, proving it and the
data left behind as above; `p` proves the file under the cursor. The screen
shows the same PROVEN or RED lines as the script. The file is encrypted under
a key only the owner holds; copy it off the forge to keep it. The seal and
the proof run `src/apps/backup_cli.ts` (the code behind `scripts/app-backup.ts`) in a child process (the passphrase in
its environment, never in argv), so the forge's event loop stays free; a
production data directory over 64 MB (`SEAL_CAP_BYTES`) is refused before it
is read, and the screen says to run the script on the host instead. Logic:
`src/apps/backup_door.ts`; tests: `test/tui-appbackup.test.ts`.

- Code: `src/apps/backup.ts`; tests: `test/app-backup.test.ts`.

**Not done:** the archive is held in memory (the terminal caps it at 64 MB;
the script on the host has no cap); no scheduled backup, no upload to a bucket, and no web page button; the
terminal seals production data only, not previews.
