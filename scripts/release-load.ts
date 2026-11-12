/**
 * `bun scripts/release-load.ts <version> --url <copy> --repo <owner/name> [--rate N] [--seconds N] [--warm N] [--results DIR]`:
 * the release step's load check (#9504, #9514, #9596). Runs bench/load.ts
 * against a copy with data twice, through the edge cache and with it
 * bypassed, writes `<version>.json` and `<version>.bypass.json` into
 * bench/results (or `--results DIR`), each with its warm-up, the target and
 * `"verdict"` ("target met" or how far it missed), and compares each with
 * the newest kept older result of its kind; exit 1 is a fall of more than
 * 20% in either. With no older result of a kind it only writes the first.
 * A `--url` that is production is refused (exit 2) before any request goes
 * out (`src/perf/production_guard.ts`). Commit the files it writes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CACHE_MODES, lastBaseline, loadArgs, resultFile } from "../src/perf/baseline.ts";
import { refuseProduction, systemResolve } from "../src/perf/production_guard.ts";

const USAGE = "usage: bun scripts/release-load.ts <major.minor.patch> --url <copy> --repo <owner/name> [--rate N] [--seconds N] [--warm N] [--results DIR]";
const [version, ...args] = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const url = valueOf("url");
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version) || url === undefined || valueOf("repo") === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const notHere = await refuseProduction(url, systemResolve);
if (notHere !== undefined) {
  console.error(`release-load: refused: ${notHere}`);
  process.exit(2);
}
// `--results` is this script's own; bench/load.ts is handed the rest.
const resultsAt = args.indexOf("--results");
const rest = resultsAt >= 0 ? [...args.slice(0, resultsAt), ...args.slice(resultsAt + 2)] : args;
const dir = resolve(valueOf("results") ?? `${import.meta.dir}/../bench/results`);
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
// Both verdicts together at the end, read back from the files that will be committed.
for (const cache of CACHE_MODES) {
  const file = `${dir}/${resultFile(version, cache)}`;
  const verdict = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { verdict?: string }).verdict : "not written";
  console.error(`release-load (${cache}): ${file}: ${verdict}`);
}
process.exit(failed);
