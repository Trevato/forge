# Snapshots — a forge back from a copy

Every night at 08:00 UTC a forge writes what cannot be rebuilt to a store,
keeps the newest fourteen, and an admin can take one any time from
**Settings → Backups**. Restoring is a command a person runs against an
empty data directory. `src/snapshot/`.

## What a snapshot holds

- `forge.db`, copied consistently while the forge runs (`VACUUM INTO`,
  never a raw copy of a file in WAL mode).
- The key the database's sealed values need, **only wrapped**:
  `secret.key.wrapped`, AES-256-GCM under a key scrypt-derived from the
  operator's passphrase. The raw `secret.key` is never written to the store,
  so whoever reads the bucket holds the data without the key. See
  [The key](#the-key).
- `ssh/`, the host key that is the forge's identity to every clone. It comes
  back with an owner-only mode; the forge refuses a key anyone else can read.
- Every repository as one git bundle of every ref (`repos/<owner>/<name>.bundle`).
  An empty repository has nothing to bundle and is skipped, not failed.
- Every app's production data (`apps/<id>/production/data/…`). SQLite files
  inside are copied the consistent way; their `-wal`/`-shm` side-files are
  the live process's and stay out. Previews are rebuilt from production and
  stay out.
- The crew's run logs (`runs/`).
- `manifest.json`: the name, when, the forge's version, counts, every file
  with its size, and `key`: `wrapped` or `none` (older snapshots: `raw`). A
  restore checks each size.

What stays out is what a boot or a deploy rebuilds: clones, checks,
pictures, previews.

## The key

The wrapping secret is `FORGE_SNAPSHOT_PASSPHRASE`, in the forge's
environment. It is not in the bucket, the repository or the database; the
operator holds it elsewhere too (a password manager, a sealed envelope).

- **Set**: every snapshot carries `secret.key.wrapped`, and the Backups page
  says the last one did.
- **Unset**: no key travels, and the Backups page says so. Snapshots still
  restore.
- **Lost**: the wrapped key cannot be opened by anyone, including us.
  Repositories, issues, app data and everything unsealed restore; every
  sealed value (forge, org and repo secrets, app variables, origin tokens,
  subscription tokens) is lost and is set again by hand. Choose the
  passphrase knowing that. A passphrase changed on the forge applies to the
  next snapshot; older snapshots stay under the one they were taken with.

Snapshots from before this change hold the raw `secret.key`; they still
restore with the key, and the Backups page tells you to take a new one.
Delete the old ones from the bucket if the bucket is not trusted.

## Where

- On the platform, the app's bucket: the `S3_*` variables the platform puts
  in the pod (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `S3_REGION`). The platform's own lanes mirror the bucket off the machine.
- Anywhere else, `FORGE_SNAPSHOT_DIR=/some/dir`.
- Or your own bucket, set on the Backups page (endpoint, bucket, region,
  access key, secret key): sealed as forge-level secrets
  (`SNAPSHOT_S3_*`), write-only, with a test button that lists the bucket.
  Precedence: sealed, then `FORGE_SNAPSHOT_DIR`, then `S3_*`; the page says
  which is in effect. A restore into an empty directory has nothing sealed
  yet, so it reads the environment: keep `S3_*` or `FORGE_SNAPSHOT_DIR`
  at hand for it.
- Given neither, no snapshots are taken, and the Backups page says so
  instead of showing an empty list that looks like a clean bill.

The store is `Bun.S3Client` or a directory behind one small interface
(`src/snapshot/store.ts`): put, get, list, delete. Nothing else.

## Restore

The printable card, seven lines, is [RESTORE.md](RESTORE.md); a test runs it.

```sh
# same S3_* as the forge runs under, or FORGE_SNAPSHOT_DIR
FORGE_SNAPSHOT_PASSPHRASE=… \
  bun run src/snapshot/restore.ts 2026-09-22T08-00-00Z /path/to/empty/data
```

With the passphrase the key is unwrapped into `secret.key` (mode 0600) and
sealed values open. A wrong passphrase refuses the restore before anything is
written. With none, the key is left out, repositories and the rest restore,
and the command lists every sealed value by name (`NAME (app slug)`,
`NAME (scope secret)`) that must be set again; the restored forge makes a new
key on first boot.

It refuses a directory that is not empty and a snapshot it cannot find or
that is missing a file. Bundles become bare repositories with the forge's
hooks installed; the mirror's memory of the bundle as an origin is removed.
Then start the forge on that directory: it migrates the database forward if
it has moved on, reconciles the index and redeploys what runs.

`test/snapshot.test.ts` is the proof: a running forge with history, a
sealed variable and an app's SQLite is snapshotted, restored into an empty
directory with the passphrase and booted there as the same forge; restored
without it, the repositories come back and the sealed variable is reported by
name. It also checks that the raw key is in no file of the store.
