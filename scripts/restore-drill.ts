/**
 * The restore drill on the box beside production (#9046): the newest
 * snapshot restored from the bucket alone, booted, and set beside
 * production. It reads only what the restore card names — the `S3_*`
 * variables (or `FORGE_SNAPSHOT_DIR`) and `FORGE_SNAPSHOT_PASSPHRASE` —
 * writes only into the empty data directory it is given, and reads
 * production through its public API, nothing else of the platform.
 *
 *   bun scripts/restore-drill.ts <data-dir> [--production https://forge.open-platform.sh]
 *
 * It restores, boots the restored forge on a free side port, checks `/`
 * answers, counts the repositories and apps anyone can see there and on
 * production, prints both, and exits 1 when any step fails or a count
 * differs. The restored directory stays: it is the box's own copy.
 */

import { resolve } from "node:path";
import { bootRestored } from "../src/snapshot/boot.ts";
import { resolveDestination } from "../src/snapshot/destination.ts";
import { publicCounts, type PublicCounts } from "../src/snapshot/public_counts.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { listSnapshots } from "../src/snapshot/snapshot.ts";
import { PREVIEW_ADMIN } from "../src/spawn/preview-looks.ts";

export const PRODUCTION = "https://forge.open-platform.sh";
/** Production's own data directory on the platform; the drill never writes there. */
const PRODUCTION_DATA = "/data";
const BOOT_MS = 60_000;

/** The arguments as plain data, or the reason they are not usable. */
export function parseArgs(args: readonly string[]): { dataDir: string; production: string } | string {
  const rest = [...args];
  let production = PRODUCTION;
  const at = rest.indexOf("--production");
  if (at >= 0) {
    production = rest[at + 1] ?? "";
    rest.splice(at, 2);
  }
  let url: URL;
  try {
    url = new URL(production);
  } catch {
    return `--production takes a URL, not ${JSON.stringify(production)}`;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    return "--production takes an https URL";
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("-"))
    return "usage: bun scripts/restore-drill.ts <data-dir> [--production URL]";
  const dataDir = resolve(rest[0]);
  if (dataDir === PRODUCTION_DATA) return `${dataDir} is production's data directory; restore into the box's own`;
  return { dataDir, production: url.origin };
}

/** The two sides' counts as lines a person reads, and which differ. */
export function compareLines(restored: PublicCounts, production: PublicCounts): { lines: string[]; differ: string[] } {
  const keys = Object.keys(restored) as (keyof PublicCounts)[];
  const differ = keys.filter((k) => restored[k] !== production[k]);
  const lines = keys.map(
    (k) => `${k}: restored ${restored[k]}, production ${production[k]}${differ.includes(k) ? "  DIFFERS" : ""}`,
  );
  return { lines, differ };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  // CLI output below is for the person at the box, and is posted on the issue.
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }
  const store = resolveDestination()?.store;
  if (store === undefined) {
    console.error("no store: export the S3_* lines of the restore card, or FORGE_SNAPSHOT_DIR");
    return 2;
  }
  const newest = (await listSnapshots(store))[0];
  if (newest === undefined) {
    console.error(`no snapshot in ${store.where}`);
    return 1;
  }
  const began = performance.now();
  const seconds = (): string => ((performance.now() - began) / 1000).toFixed(1);
  console.log(`restore-drill: ${newest.name} from ${store.where} into ${args.dataDir}`);
  const done = await restoreSnapshot(store, newest.name, args.dataDir, {
    passphrase: process.env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined,
  });
  console.log(`restored ${done.files} files and ${done.repos} repositories, key ${done.key}, ${seconds()}s`);
  if (done.sealedMissing.length > 0) console.log(`sealed values to set again: ${done.sealedMissing.length}`);

  let restored: PublicCounts | undefined;
  const booted = await bootRestored(args.dataDir, BOOT_MS, undefined, async (base) => {
    const home = await fetch(`${base}/`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (home.status >= 400) throw new Error(`/ answered ${home.status}`);
    console.log(`booted: / answered ${home.status}, ${seconds()}s`);
    // The boot is a preview, which seeds the preview admin's sample on top.
    restored = await publicCounts(base, { except: PREVIEW_ADMIN });
  });
  if (!booted.ok || restored === undefined) {
    console.error(`boot failed: ${booted.reason || "no counts"}`);
    return 1;
  }
  let production: PublicCounts;
  try {
    production = await publicCounts(args.production);
  } catch (error) {
    console.error(`production ${args.production} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { lines, differ } = compareLines(restored, production);
  for (const line of lines) console.log(line);
  console.log(differ.length === 0 ? `restore-drill: green, ${seconds()}s` : `restore-drill: red, ${differ.join(" and ")} differ`);
  return differ.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
