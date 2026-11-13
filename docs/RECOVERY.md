# Recovery — read this at 3 a.m.

Print it. Keep it somewhere that is not the forge. `test/recovery-doc.test.ts`
keeps it true to `src/snapshot/`.

## Where the copies are

Snapshots are objects in the forge's bucket (`S3_BUCKET`, at `S3_ENDPOINT`,
region `S3_REGION`) under the prefix `snapshots/<name>/`, one directory per
snapshot, named like `2026-09-22T08-00-00Z`. The restore command accepts `latest` for
the newest; no object is called that.

## Where the verdicts are posted

Sundays 09:00 UTC the forge drills a restore of the newest snapshot, boots it
on a side port and reads `/api/v1/health`, all within 10 min plus 1 s per MB
(10^6 bytes) of the snapshot's `bytes`, at most 45 min — a 400 MB snapshot has
16 min 40 s. Every get and its retries keep to what is left of that budget, so
a stalled store fails the drill within it, naming the object. One comment lands on the recovery
issue (`FORGE_RECOVERY_ISSUE` in `FORGE_RECOVERY_REPO`): snapshot, restore time,
health, counts, pass or fail. A failed drill is an inbox card naming the step
(fetch, restore, open, count, unseal, health) and its budget in minutes, run again at boot
and every three hours until one passes. No comment this week: backups unproven.

## What a restore needs

Export these, with the values the forge ran under:

    S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY

and `FORGE_SNAPSHOT_PASSPHRASE`, which is in the owner's safe and nowhere
else. Without it the restore still works, but the secret key stays behind and
every sealed value is set again by hand. A wrong one refuses before writing.
A machine with `git`, `bun` and a clone of the forge (`bun install`).

## Route 1 — the restore command

    bun run src/snapshot/restore.ts <snapshot-name|latest> <data-dir> [--clones N] [--offsite]

`<data-dir>` must be empty or new. `--clones N` (1–32): repositories cloned at once
(default: cores less one, 2–16). `--offsite`: from the sealed lane, [features/offsite-lane.md](features/offsite-lane.md).

Then boot the forge on that directory, on a side port, off the public one:

    FORGE_DATA=<data-dir> PORT=3999 FORGE_SSH_PORT=0 bun run src/main.ts

Look at, in order:

1. `curl localhost:3999/api/v1/health` answers ok.
2. The home page, signed in as the owner: the repositories and the board.
3. One repository's issues: the latest ones you remember are there.

If all three hold, point the real service at `<data-dir>`.

## Route 2 — the objects by hand

Use it when the restore command fails or only one file is wanted. Every
object is plain, under `snapshots/<name>/`; fetch with any S3 client:

    manifest.json                    what is there
    forge.db                         the database
    secret.key.wrapped               the key, under the passphrase
    ssh/...                          the SSH host key
    repos/<owner>/<repo>.bundle      one git bundle per repository
    apps/<id>/production/data/...    each app's data
    runs/...                         run logs

Put `forge.db` and `ssh/` in a new data directory; turn each bundle back into
a repository with `git clone --mirror <file> <data-dir>/repos/<owner>/<repo>.git`
(the layout `src/git/repos.ts` reads). Boot as above. The key is wrapped with
scrypt and AES-256-GCM (`src/snapshot/wrap.ts`): only `restore.ts` opens it,
so by hand the sealed values are set again.

## When the drill is red

The weekly drill restores the newest snapshot into scratch and names where it
stopped: a step, and for `restore` a phase inside it. Each entry says what it
was doing, the likely cause, and the first thing to check. Whatever the step,
the next move is the same: run Route 1 by hand on a new directory and watch
which line it stops at.

### Steps

- **fetch** — listing the store for the newest snapshot. Likely the store is
  unreachable or its keys changed, or no snapshot exists. Check the `S3_*`
  variables and that the store lists the snapshot objects.
- **restore** — running the restore command; the phase below says where.
  Likely a bad snapshot or a slow store. Check the phase, then Route 1.
- **open** — opening the restored `forge.db`. Likely the file is truncated or
  corrupt. Check its size against the snapshot's manifest.
- **count** — counting rows and comparing with the counts the snapshot kept.
  Likely the snapshot was cut mid-write or rows were lost. Check which table
  the message names and its count in the snapshot.
- **unseal** — opening one sealed value with the restored key. Likely the key
  is missing or from another forge, or the passphrase is wrong. Check
  `FORGE_SNAPSHOT_PASSPHRASE` and that the snapshot holds the key.
- **health** — booting the restored forge and asking it for health. Likely a
  migration or config problem, or a boot slower than the limit. Boot it by
  hand as in Route 1 and read its log.

### Restore phases

- **manifest** — reading the snapshot's list of files and bundles. Likely the
  manifest object is missing or damaged. Check the object exists in the store.
- **files** — fetching the plain files. Likely a slow or failing store. Check
  how far it got against the manifest's file count, then retry.
- **unpack** — unpacking the fetched files into the data directory. Likely the
  disk is full or the archive is damaged. Check free space.
- **bundles** — cloning each repository from its bundle. Likely a slow store
  or many repositories. Compare its counts with the snapshot's and retry the
  restore by hand with Route 1.
- **key** — restoring the secret key, opened with the passphrase. Likely the
  passphrase is missing or wrong. Check `FORGE_SNAPSHOT_PASSPHRASE`.

Replacing a leaked `secret.key`: docs/features/rotate-secret-key.md.

## What a snapshot does NOT hold

- Sealed values, unless the passphrase was set: they stay sealed and are set
  again by hand (the restore lists them by name).
- App variables, which are sealed the same way.
- The crew's clones: working copies that agents make again from the
  repositories.
- Anything outside the data directory: the code, the machine, the bun.
