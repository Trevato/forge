/**
 * `bun scripts/release-load.ts <version> --url <copy> --repo <owner/name> [--rate N] [--seconds N]`:
 * the release step's load check (#9504). Runs bench/load.ts against a copy
 * with data, writes bench/results/<version>.json and compares with the
 * newest kept older result; exit 1 is a fall of more than 20%. With no older
 * result it only writes the first baseline. Commit the file it writes.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { lastBaseline, loadArgs } from "../src/perf/baseline.ts";

const [version, ...rest] = process.argv.slice(2);
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version) || !rest.includes("--url") || !rest.includes("--repo")) {
  console.error("usage: bun scripts/release-load.ts <major.minor.patch> --url <copy> --repo <owner/name> [--rate N] [--seconds N]");
  process.exit(2);
}
const dir = `${import.meta.dir}/../bench/results`;
mkdirSync(dir, { recursive: true });
const kept = lastBaseline(existsSync(dir) ? readdirSync(dir) : [], version);
const cmd = ["bun", `${import.meta.dir}/../bench/load.ts`, ...loadArgs(rest, version, dir, kept)];
console.error(kept === undefined ? `release-load: no older baseline; writing the first, ${version}.json` : `release-load: comparing with ${kept}`);
process.exit(await Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" }).exited);
