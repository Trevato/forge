/**
 * Make a second machine a read-only standby (#9657): restore a snapshot the
 * forge's backups made into an empty data directory, and verify it.
 *
 *   bun scripts/standby-restore.ts <snapshot|latest> <data-dir>
 *
 * The store is the one the forge backs up to: the `S3_*` variables, or
 * `FORGE_SNAPSHOT_DIR`; `FORGE_SNAPSHOT_PASSPHRASE` opens sealed values.
 * Then serve reads from it:
 *
 *   FORGE_READ_ONLY=1 FORGE_DATA=<data-dir> PORT=3000 bun run src/main.ts
 *
 * Exits 0 when the database's integrity check passes and every repository
 * is on disk, 1 when it does not, 2 on a bad argument. See
 * docs/features/maintenance.md.
 */
import { resolve } from "node:path";
import { resolveDestination } from "../src/snapshot/destination.ts";
import { restoreStandby } from "../src/snapshot/standby.ts";

async function main(args: readonly string[]): Promise<number> {
  const [snapshot, dir] = args;
  // CLI output below is for the person at the machine.
  if (args.length !== 2 || !snapshot || !dir || dir.startsWith("-")) {
    console.error("usage: bun scripts/standby-restore.ts <snapshot|latest> <data-dir>");
    return 2;
  }
  const dataDir = resolve(dir);
  if (dataDir === "/data") {
    console.error("/data is the production data directory; restore into the standby's own");
    return 2;
  }
  const store = resolveDestination()?.store;
  if (store === undefined) {
    console.error("no store: export the S3_* variables, or FORGE_SNAPSHOT_DIR");
    return 2;
  }
  try {
    const done = await restoreStandby(store, snapshot, dataDir, process.env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined);
    console.log(`restored ${done.name}: ${done.restored.files} files, ${done.repos} repositories, key ${done.restored.key}`);
    if (done.problems.length > 0) {
      for (const p of done.problems) console.error(`standby-restore: ${p}`);
      return 1;
    }
    console.log("verified: database integrity ok, every repository on disk");
    console.log(`serve reads: FORGE_READ_ONLY=1 FORGE_DATA=${dataDir} PORT=3000 bun run src/main.ts`);
    return 0;
  } catch (error) {
    console.error(`standby-restore: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
