/**
 * `bun scripts/release-load.ts <version> --url <copy> --repo <owner/name> [--rate N] [--seconds N]`:
 * the release step's load check (#9504, #9514). Runs bench/load.ts against a
 * copy with data twice, through the edge cache and with it bypassed, writes
 * bench/results/<version>.json and <version>.bypass.json, and compares each
 * with the newest kept older result of its kind; exit 1 is a fall of more
 * than 20% in either. With no older result of a kind it only writes the
 * first. Commit the files it writes.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { CACHE_MODES, lastBaseline, loadArgs } from "../src/perf/baseline.ts";

const [version, ...rest] = process.argv.slice(2);
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version) || !rest.includes("--url") || !rest.includes("--repo")) {
  console.error("usage: bun scripts/release-load.ts <major.minor.patch> --url <copy> --repo <owner/name> [--rate N] [--seconds N]");
  process.exit(2);
}
const dir = `${import.meta.dir}/../bench/results`;
mkdirSync(dir, { recursive: true });
// Through the edge, then with it bypassed (#9514): both run, and either falling is the gate.
let failed = 0;
for (const cache of CACHE_MODES) {
  const kept = lastBaseline(existsSync(dir) ? readdirSync(dir) : [], version, cache);
  const cmd = ["bun", `${import.meta.dir}/../bench/load.ts`, ...loadArgs(rest, version, dir, kept, cache)];
  console.error(kept === undefined ? `release-load (${cache}): no older baseline; writing the first` : `release-load (${cache}): comparing with ${kept}`);
  const code = await Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: { BUN_CONFIG_MAX_HTTP_REQUESTS: "65000", ...process.env } }).exited;
  if (code !== 0) failed = code;
}
process.exit(failed);
