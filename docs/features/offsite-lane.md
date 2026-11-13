# The off-site backup lane

The forge's own backup lane (#11805) is the mirror pass that runs in the
forge's process every hour and after every snapshot. It copies the newest
snapshots to a bucket on neither machine (`FORGE_MIRROR_S3_*`, or the mirror
sealed on the Backups page), and every object it writes is sealed first:
AES-256-GCM under a fresh IV, the key derived from `FORGE_SNAPSHOT_PASSPHRASE`
by scrypt (`src/snapshot/sealed_store.ts`). Paths inside a snapshot are hidden
(an HMAC of each path), so the bucket does not even name a repository.

- **The salt is the lane's own.** The first pass writes one unsealed header,
  `sealed/lane.json`: a random 16-byte salt and a check value (an HMAC under
  the derived key, never the key). A guess at the passphrase costs one scrypt
  for that lane alone, and a wrong passphrase is said as such before any
  object is read.
- **The key is in the passphrase alone**: not in this repository, not on the
  bucket. Keep it with the operator, apart from the bucket's keys.
- **Without the passphrase the lane writes nothing.** Every pass fails saying
  `FORGE_SNAPSHOT_PASSPHRASE is not set`, and `/system` shows the lane red;
  not one unsealed byte leaves the forge.

For the lane to stand without pg-grand, the nightly snapshot itself must land
on the forge's own disk (`FORGE_SNAPSHOT_DIR` on its volume) rather than the
platform's MinIO: the lane copies from there.

## Restore from it

On a fresh machine, follow [RESTORE.md](../RESTORE.md), exporting the lane's
bucket in place of line 3, keeping line 4 (the passphrase), and adding
`--offsite` to line 5:

    export FORGE_MIRROR_S3_ENDPOINT=… FORGE_MIRROR_S3_BUCKET=… FORGE_MIRROR_S3_ACCESS_KEY=… FORGE_MIRROR_S3_SECRET_KEY=…
    bun run src/snapshot/restore.ts latest <data-dir> --offsite

`bun scripts/restore-drill.ts <empty-data-dir> --offsite` drills it the same
way. Without the passphrase both refuse before writing anything; a restore
never starts a lane on an empty bucket.

## The drill

The weekly drill, the Backups page's button and the MCP `restore_drill`
restore the newest snapshot from the off-site lane when the forge has one
(the destination otherwise) into a scratch forge, boot it, and check that
`/api/v1/health` answers and `/` answers below 400. A drill waits for a mirror
pass in flight, at most the drill's floor budget (10 min), then reads the lane
as it stands. Each drill is kept with the store it restored from.

## Where to see it

- **Web**: `/system`, under _Off-site backup_: one sentence, and behind it
  where the lane writes, whether it is encrypted, its last success, and the
  last drill with where it restored from.
- **Terminal**: the palette's **Off-site backup**, the same rows.
- **MCP**: `system` with `{ kind: "offsite" }`, the same reading as
  `{ health, says, where, sealed, lastSuccess, newest, error, drill }`.

All three are a forge admin's alone.
