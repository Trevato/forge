# Snapshots — a forge back from a copy

Every night at 08:00 UTC a forge writes what cannot be rebuilt to a store,
keeps the newest fourteen, and an admin can take one any time from
**Settings → Backups**. Restoring is a command a person runs against an
empty data directory. `src/snapshot/`.

## What a snapshot holds

- `forge.db`, copied consistently while the forge runs (`VACUUM INTO`,
  never a raw copy of a file in WAL mode).
- `secret.key`, which the database's sealed values need, and `ssh/`, the
  host key that is the forge's identity to every clone. Both come back with
  owner-only modes; the forge refuses a key anyone else can read.
- Every repository as one git bundle of every ref (`repos/<owner>/<name>.bundle`).
  An empty repository has nothing to bundle and is skipped, not failed.
- Every app's production data (`apps/<id>/production/data/…`). SQLite files
  inside are copied the consistent way; their `-wal`/`-shm` side-files are
  the live process's and stay out. Previews are rebuilt from production and
  stay out.
- The crew's run logs (`runs/`).
- `manifest.json`: the name, when, the forge's version, counts, every file
  with its size. A restore checks each size.

What stays out is what a boot or a deploy rebuilds: clones, checks,
pictures, previews.

## Where

- On the platform, the app's bucket: the `S3_*` variables the platform puts
  in the pod (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `S3_REGION`). The platform's own lanes mirror the bucket off the machine.
- Anywhere else, `FORGE_SNAPSHOT_DIR=/some/dir`.
- Given neither, no snapshots are taken, and the Backups page says so
  instead of showing an empty list that looks like a clean bill.

The store is `Bun.S3Client` or a directory behind one small interface
(`src/snapshot/store.ts`): put, get, list, delete. Nothing else.

## Restore

```sh
# same S3_* as the forge runs under, or FORGE_SNAPSHOT_DIR
bun run src/snapshot/restore.ts 2026-09-22T08-00-00Z /path/to/empty/data
```

It refuses a directory that is not empty and a snapshot it cannot find or
that is missing a file. Bundles become bare repositories with the forge's
hooks installed; the mirror's memory of the bundle as an origin is removed.
Then start the forge on that directory: it migrates the database forward if
it has moved on, reconciles the index and redeploys what runs.

`test/snapshot.test.ts` is the proof: a running forge with history, a
sealed variable and an app's SQLite is snapshotted, restored into an empty
directory, and booted there as the same forge.
