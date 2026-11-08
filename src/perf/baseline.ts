/**
 * Which kept load result a release is compared against (#9504).
 * File names in, the newest older one out; `bench/load.ts` does the judging.
 */

import { compareVersions } from "../release/shipped.ts";

/**
 * Each release keeps two results (#9514): `<version>.json` read through the
 * edge cache, `<version>.bypass.json` with it bypassed. Each is compared only
 * with the same kind.
 */
export type CacheMode = "edge" | "bypass";
export const CACHE_MODES: readonly CacheMode[] = ["edge", "bypass"];

const KEPT = /^(\d+\.\d+\.\d+)(\.bypass)?\.json$/;

/** The file a release's result of `cache` kind is kept in. */
export const resultFile = (version: string, cache: CacheMode = "edge"): string =>
  `${version}${cache === "bypass" ? ".bypass" : ""}.json`;

/** The newest kept result of `cache` kind strictly older than `version`, as a file name; undefined when none is kept. */
export function lastBaseline(files: readonly string[], version: string, cache: CacheMode = "edge"): string | undefined {
  const older = files
    .map((f) => KEPT.exec(f))
    .filter((m): m is RegExpExecArray => m !== null && (m[2] === undefined) === (cache === "edge"))
    .map((m) => m[1]!)
    .filter((v) => compareVersions(v, version) > 0)
    .sort(compareVersions);
  const newest = older[0];
  return newest === undefined ? undefined : resultFile(newest, cache);
}

/**
 * The `bench/load.ts` arguments for a release: 500 a second (the rate #9514
 * holds the forge to) for 20 s after a 20 s warm-up, `--bypass` for that
 * kind, `--compare` added when an older result of the same kind is kept.
 */
export function loadArgs(rest: readonly string[], version: string, dir: string, kept: string | undefined, cache: CacheMode = "edge"): string[] {
  const args = [...rest, "--version", version, "--out", `${dir}/${resultFile(version, cache)}`];
  if (!rest.includes("--rate")) args.push("--rate", "500");
  if (!rest.includes("--seconds")) args.push("--seconds", "20");
  if (!rest.includes("--warm")) args.push("--warm", "20");
  if (cache === "bypass") args.push("--bypass");
  if (kept !== undefined) args.push("--compare", `${dir}/${kept}`);
  return args;
}

/** The line `cut-release` ends with: the load check to run against a copy with data before pushing the tag. */
export function loadCheckHint(version: string): string {
  return `cut-release: before pushing the tag, run the load check against a copy with data:\n  bun scripts/release-load.ts ${version} --url <copy> --repo <owner/name>\nthen commit bench/results/${resultFile(version)} and bench/results/${resultFile(version, "bypass")}`;
}
