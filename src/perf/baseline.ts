/**
 * Which kept load result a release is compared against (#9504).
 * File names in, the newest older one out; `bench/load.ts` does the judging.
 */

import { compareVersions } from "../release/shipped.ts";

const KEPT = /^(\d+\.\d+\.\d+)\.json$/;

/** The newest kept result strictly older than `version`, as a file name; undefined when none is kept. */
export function lastBaseline(files: readonly string[], version: string): string | undefined {
  const older = files
    .map((f) => KEPT.exec(f)?.[1])
    .filter((v): v is string => v !== undefined && compareVersions(v, version) > 0)
    .sort(compareVersions);
  const newest = older[0];
  return newest === undefined ? undefined : `${newest}.json`;
}

/** The `bench/load.ts` arguments for a release: defaults filled, `--compare` added when an older result is kept. */
export function loadArgs(rest: readonly string[], version: string, dir: string, kept: string | undefined): string[] {
  const args = [...rest, "--version", version, "--out", `${dir}/${version}.json`];
  if (!rest.includes("--rate")) args.push("--rate", "500");
  if (!rest.includes("--seconds")) args.push("--seconds", "20");
  if (kept !== undefined) args.push("--compare", `${dir}/${kept}`);
  return args;
}

/** The line `cut-release` ends with: the load check to run against a copy with data before pushing the tag. */
export function loadCheckHint(version: string): string {
  return `cut-release: before pushing the tag, run the load check against a copy with data:\n  bun scripts/release-load.ts ${version} --url <copy> --repo <owner/name>\nthen commit bench/results/${version}.json`;
}
