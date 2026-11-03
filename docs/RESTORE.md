# Restore card — the forge back on a fresh machine

Print this. Keep it somewhere that is not the forge.

## Have ready

- The **passphrase** (`FORGE_SNAPSHOT_PASSPHRASE`). Without it every sealed
  value is lost and set again by hand; the rest restores.
- The **store address**: the directory (`FORGE_SNAPSHOT_DIR`) or the bucket
  (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `S3_REGION`; export them in place of line 3).
- The **keys**: access to the forge's git remote and the store's credentials.
  The forge's own host key and secret key come out of the snapshot.
- A machine with `git`, `bun` and an empty data directory.

## The lines

Replace `<store-dir>`, `<data-dir>` and `<passphrase>`. A line ending
`# network` needs the network and `# boot` starts the forge and does not
return; `test/restore-card.test.ts` runs every other line against a test
snapshot, so this card cannot drift from the command.

1. `git clone https://forge.open-platform.sh/trevato/forge.git forge && cd forge # network`
2. `bun install # network`
3. `export FORGE_SNAPSHOT_DIR=<store-dir>`
4. `export FORGE_SNAPSHOT_PASSPHRASE=<passphrase>`
5. `bun run src/snapshot/restore.ts latest <data-dir>`
6. `test -s <data-dir>/forge.db`
7. `FORGE_DATA=<data-dir> bun run src/main.ts # boot`

The restore prints what it brought back. A wrong passphrase refuses before
writing anything; a missing one restores without the key and lists the
sealed values to set again. To pick an older snapshot, put its name
(`2026-09-22T08-00-00Z`) where line 5 says `latest`. Details:
[SNAPSHOT.md](SNAPSHOT.md).

On a box that stays: `scripts/box-install.sh`, then lines 3–6 as the `forge`
user with `<data-dir>` `/var/lib/forge`, then `systemctl enable --now forge`
in place of line 7 ([EXTRACT.md](EXTRACT.md), _The box beside production_).

## The drill on the box

`scripts/restore-drill.ts` runs lines 3–7 and checks them, from the bucket
alone: with the card's `S3_*` lines and the passphrase exported, as the
`forge` user,

    bun scripts/restore-drill.ts <empty-data-dir>

restores the newest snapshot into that directory, boots it on a free side
port, checks `/` answers, and prints the repositories and apps anyone can
see beside production's public API (`--production <url>`, default
`https://forge.open-platform.sh`); the restored forge boots as a preview,
so the sample its preview admin seeds is left out. It exits 1 when a step fails or a count
differs. It writes only into the directory it is given, which must be empty,
refuses `/data`, and leaves the restored copy in place.
`test/restore-drill-script.test.ts` runs it against a tiny snapshot and a
stub bucket.
