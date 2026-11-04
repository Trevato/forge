# The backups line on Resilience (#8867)

`/resilience` and the terminal's Resilience dialog (palette: Resilience,
admins) both open with one line on backups. Both read it from
`src/snapshot/backups_line.ts`, so the web page and the terminal use the same
words.

- **With a store:** `Snapshots go to <where>.` Here `<where>` is the store's
  own name for itself: `s3://…` for a bucket, the path for a directory. It
  never includes a key. On the web, the line links to Backups, which lists
  the snapshots.
- **With none:** `Backups are off here: this forge was given no bucket to
  keep snapshots in.` This is muted text, not an alarm: a preview and a forge
  on a desk have no bucket on purpose. On the web, the line links to Backups,
  which says how to give the forge one.
- **An empty name counts as none.** A store whose `where` is blank reads as
  off. Without this rule the line would end in a bare "Snapshots go to .".

## Giving a forge a bucket

The first of these that is set wins (`src/snapshot/destination.ts`):

1. **Sealed in the forge.** On the web, `/settings/backups` takes an
   endpoint, bucket, region and two keys. In the terminal, the Resilience
   dialog's `d` asks for the same five fields. The keys are sealed and are
   never shown again. `t` tests the destination.
2. **A directory:** `FORGE_SNAPSHOT_DIR=/path` in the forge's environment.
3. **The host's bucket:** `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`,
   `S3_SECRET_KEY` and optionally `S3_REGION`, which a host-provisioned forge is
   given.

The line describes the store that the running process holds. After you save
a destination, the next use resolves it again and the line names it.
