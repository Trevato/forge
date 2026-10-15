# Recovery — read this at 3 a.m.

Print it. Keep it somewhere that is not the forge. `test/recovery-doc.test.ts`
keeps it true to `src/snapshot/`.

## Where the copies are

Snapshots are objects in the forge's bucket (`S3_BUCKET`, at `S3_ENDPOINT`,
region `S3_REGION`) under the prefix `snapshots/<name>/`, one directory per
snapshot, named like `2026-09-22T08-00-00Z`. The restore command accepts `latest` for
the newest; no object is called that.

## What a restore needs

Export these, with the values the forge ran under:

    S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY

and `FORGE_SNAPSHOT_PASSPHRASE`, which is in the owner's safe and nowhere
else. Without it the restore still works, but the secret key stays behind and
every sealed value is set again by hand. A wrong one refuses before writing.
A machine with `git`, `bun` and a clone of the forge (`bun install`).

## Route 1 — the restore command

    bun run src/snapshot/restore.ts <snapshot-name|latest> <data-dir>

`<data-dir>` must be empty or new; the command refuses otherwise. It prints
the files and repositories it brought back.

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

## What a snapshot does NOT hold

- Sealed values, unless the passphrase was set: they stay sealed and are set
  again by hand (the restore lists them by name).
- App variables, which are sealed the same way.
- The crew's clones: working copies that agents make again from the
  repositories.
- Anything outside the data directory: the code, the machine, the bun.
