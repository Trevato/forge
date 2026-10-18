# Snapshots — a forge back from a copy

Every night at 08:00 UTC a forge writes what cannot be rebuilt to a store,
keeps the newest fourteen, and an admin can take one any time from
**Settings → Backups**. Restoring is a command a person runs against an
empty data directory. `src/snapshot/`.

## What a snapshot holds

- `forge.db`, copied consistently while the forge runs (`VACUUM INTO`,
  never a raw copy of a file in WAL mode), then zstd-compressed and cut in
  16 MB parts: `forge.db.zst.0000`, `forge.db.zst.0001`, … Each part is its
  own put with its own deadline and retries, so a slow uplink carries it
  and a dropped connection costs one part, not the database. The manifest's
  `packed` says what the parts make and how big that is; a restore joins
  them, unpacks, and refuses a size that does not match. The log line
  `database packed` gives each night's ratio. Snapshots from before this
  hold a plain `forge.db` and still restore. The parts go up through the
  snapshot's upload queue like every other object: at most eight objects
  or 64 MB in flight, so four 16 MB parts at a time.

  Packing and restoring both hold the database in memory: the copy, its
  compressed form (the parts are views of it, not copies), and on restore
  the joined parts and the unpacked file, about three times the database
  at the peak (a 334 MB database at about 1 GB). A database that outgrows
  the app's memory limit needs a streaming pack; until then that limit,
  not the uplink, is the ceiling.
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
  with its size, `packed` (the files that went up in parts), and `key`:
  `wrapped` or `none` (older snapshots: `raw`). A restore checks each size.

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

## The off-box mirror

A second S3-compatible bucket (Backblaze B2, say) that every snapshot is
copied to, so the snapshots do not die with the machine. Seal it on the
Backups page (`SNAPSHOT_MIRROR_S3_*`, write-only like the destination) or
give `FORGE_MIRROR_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY` and
optionally `_REGION`. A pass runs right after each snapshot, thirty seconds
after boot and every hour: it copies the newest fourteen snapshots the mirror
lacks (manifest last, so a half copy is never listed; objects already there
are skipped), then prunes the mirror to fourteen. What it found is kept in
`mirror/state.json` under the data directory. The Backups page shows the
mirror's reachability, its newest snapshot and when it was last confirmed
level. A pass that fails (store unreachable, or a snapshot that did not land)
or a mirror not confirmed level for a day is one card on the board
(`mirror`) and one push to the admin, the path the drill uses. Not done: the
mirror is copied from the primary store, not written in parallel, so a snapshot
that never landed on the primary is not seen by it.

The store is `Bun.S3Client` or a directory behind one small interface
(`src/snapshot/store.ts`): put, get, list, delete. Nothing else. Every call
is tried five times; an attempt that has not answered by its deadline counts
as failed. A put's deadline follows its size: its bytes at a floor of
5 Mbit/s, plus 60 s. A fixed 180 s once failed every attempt at a 334 MB
database behind a 15 Mbit/s uplink (#2536).

## When a snapshot fails

Its outcome is kept in `snapshot/state.json` under the data directory, so a
restart forgets nothing. A failure shows straight away as a card on the board
(`snapshot-failed`, pointing at Backups), in the terminal's dashboard among
the forge's needs, and as a red line on the Backups page with the reason and
since when. The forge tries again within the hour, not the next night. The
next snapshot that lands, nightly or on demand, clears both.

A forge given nowhere to put a snapshot has not failed: nothing is kept, no
card is raised, and nothing is retried sooner than the nightly. The Backups
page says there is no destination.

## The restore drill

A backup nobody has restored is a hope. **Settings → Backups → Run a drill**
(admins only; anyone else gets 403) restores the newest snapshot into a
scratch directory under the data directory, opens the database read-only,
counts repositories and issues, opens one sealed value with the restored key,
and removes the scratch whatever happened. The page waits until it finishes,
for up to 10 minutes; a step that hangs past that is red and names the step.
The restore reads several objects at a time, under the same limits as the
upload (`IN_FLIGHT` gets, `IN_FLIGHT_BYTES` held): read one after another, a
snapshot of thousands of objects spent the drill's whole 10 minutes in the
restore step (#2539).
One drill runs at a time: a second click, or a retry after a proxy timeout,
joins the drill already running rather than starting another restore. Every
run is a row in the `drill` table, and the last one shows as a line on the
Backups page: when, which snapshot, how long, the counts, and green or the
step that failed.

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
