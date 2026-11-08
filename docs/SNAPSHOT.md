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

## Off the machine

Home's **Last off-box backup** is the newest time a snapshot was known to be
off the machine (`src/snapshot/off_box.ts`): the newest the mirror holds, or
the newest that landed in a destination that is a bucket, whichever is later.
Each landing records whether its store was one (`offBox` in
`snapshot/state.json`): a directory never is, whatever volume it is on, nor
is a bucket served from loopback. Before #3701 the tile read the mirror
alone, so a forge whose nightly landed in the platform's bucket every morning,
with no second bucket, read "never". An outcome kept before stores were
recorded is annotated from the store in effect at the first mirror pass after
boot.

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

## Backup lanes

The platform's backup lanes (`FORGE_BACKUP_LANES`) and how each is judged: docs/features/backup-truth.md, "Platform backup lanes".

## Progress

A snapshot uploads eight objects at a time. Run logs older than a day go up
bundled per day (cut at 4 MB, so a long history is several objects, never one
huge one); restore unpacks them. While one runs, progress shows on
**Settings → Backups** and as a line in the log every 500 objects or minute.
The terminal has no backups view, so it has no readout.

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
Repositories come back four clones at a time, not one after another (#2543).
One drill runs at a time: a second click, or a retry after a proxy timeout,
joins the drill already running rather than starting another restore. Every
run is a row in the `drill` table, and the last one shows as a line on the
Backups page: when, which snapshot, how long, the counts, and green or the
step that failed.

The drill runs on its own every Sunday 09:00 UTC, and a forge that was down
then catches up five minutes after boot. A red drill does not keep the
week's slot: it is owed again `RED_RETRY_MS` (three hours) after it ran,
and at a boot once it is `BOOT_RED_FLOOR_MS` (30 minutes) old, until one
passes (`src/snapshot/due.ts`). The floor keeps a crash loop with a broken
restore from running a restore on every boot. Kept for the
week, a drill red at 09:11 stood as a card long after the fix deployed at
10:18 (#2541).

**Run a drill** on the same page (admins only) restores the newest snapshot
into scratch, opens it, counts what is there and unseals a value; the page
waits for it, up to 10 minutes, and the last drill shows there as one line,
ending with the drill's time against its budget and each part's time, longest first ("6 min
12 s of its 14 min budget: clone 4 min, download 58 s, …"), or only the time against the
budget when no part was timed; drills from before this show none. The budget is 10 min
plus 1 s per MB of snapshot, at most 45 min (`docs/RECOVERY.md`).
The parts are download, decompress, clone, open, and start and migrate (the
whole side-boot of the restored forge, process start included). The same words,
slowest named, are in the drill's log line and in a red drill's card
("… (download about 8 min, decompress 40 s, …; download was the slowest)").

Each snapshot's manifest keeps
the five counts of its database; a restore that counts differently is red at
`count` and, like any red drill, one board line and one push. Snapshots from
before the counts were kept are not compared.

## Failure domains, and what the owner is told

**Failure domains** (a card at the foot of `/settings/backups`; the old
`/settings/resilience` sends there, and `/resilience` is the THREATS.md page): one row per failure domain from
`docs/DOMAINS.md` — what breaks, the words the forge says, and the domain's
last kept drill (when, green or red with its reason, seconds until back) or
the sentence on why it is not drilled. In the terminal it is the **Failure domains**
command (`ctrl+k`; the **Resilience** command is the THREATS.md one), shown to an admin only and read through the same
`listResilience` action. Only the latest drill per domain is shown.
An admin presses `d` on Failure domains to run the restore drill, behind a confirm, with the same words as the Backups button and MCP `restore_drill`; it keeps the snapshot drill record only and leaves the domain drills as they are.
The **Owner's needs** command (admin only, `ownerView`) is the owner's one screen: the forge's needs as the board strip says them, where snapshots go (and any mirror) with the newest snapshot, and every domain with what the owner does.

A red drill, or none in eight days, is one line for the forge's admin on the
board's forge strip, in the terminal's dashboard (same `forgeNeeds`), and in
MCP `health` and `asks`; it names the failed step and the next green drill
clears it. An admin with a phone URL gets one push per cause (a new red
drill, or the silence), also when eight days pass with no event: the notifier
wakes every 10 minutes for it. The time the forge first owed a drill is kept
at boot in `drill/first-seen`; if the disk will not take it, a warning is
logged and a forge with no drill ever is not flagged.

Snapshots written to a directory on the forge's own volume, with no off-box
mirror set, are lost with that volume. That is one line for the forge's admin,
"Snapshots are kept on the forge's own volume and mirrored nowhere: losing the
volume loses them too.", on the board's forge strip (linking Settings →
Backups), in the terminal's dashboard (same `forgeNeeds`), in the asks, in
`GET /api/v1/health` and MCP `health`. Anyone else sees nothing. It clears when
the destination moves to another volume or a bucket, or a mirror is set. Every
one of those reads the vitals through `forgeVitals` in `src/actions/health.ts`.

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

The dump, a line per lane and the platform-free drill: [backup-truth.md](features/backup-truth.md), _Leaving the platform_.
