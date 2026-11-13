/**
 * Files moved with a proof: a SHA-256 manifest of a tree, a copy of it into
 * `FORGE_APP_DATA`, and a comparison of the manifests at both ends
 * (docs/features/platform-app-move.md, step 3). Plain data in, plain data out.
 *
 * Only regular files and directories move. A symlink or device is never
 * followed or copied: it is listed as `skipped`, so the person sees what was
 * left behind instead of what a link happened to point at.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface ManifestEntry {
  /** Path relative to the tree's root, `/`-separated. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  entries: ManifestEntry[];
  /** Relative paths of anything that is not a regular file or directory. */
  skipped: string[];
}

export interface ManifestDiff {
  missing: string[];
  extra: string[];
  changed: string[];
}

/** SHA-256 of one file, read in chunks so a large upload never sits in memory. */
export function hashFile(path: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1 << 16);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** The manifest of `root`: every regular file, sorted by path. */
export function buildManifest(root: string): Manifest {
  const entries: ManifestEntry[] = [];
  const skipped: string[] = [];
  const walk = (rel: string): void => {
    const dir = rel === "" ? root : join(root, rel);
    for (const name of readdirSync(dir).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory()) walk(childRel);
      else if (stat.isFile()) {
        entries.push({ path: childRel, bytes: stat.size, sha256: hashFile(join(root, childRel)) });
      } else skipped.push(childRel);
    }
  };
  walk("");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, skipped };
}

/** The manifest as text, `sha256  bytes  path` a line: what goes in the issue, and what `sha256sum` style tools can check. */
export function manifestText(manifest: Manifest): string {
  return manifest.entries.map((e) => `${e.sha256}  ${e.bytes}  ${e.path}`).join("\n") + (manifest.entries.length ? "\n" : "");
}

/** What differs between the source's manifest and the target's. Empty on all three means the copy is proven. */
export function compareManifests(source: Manifest, target: Manifest): ManifestDiff {
  const have = new Map(target.entries.map((e) => [e.path, e]));
  const want = new Set(source.entries.map((e) => e.path));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const e of source.entries) {
    const there = have.get(e.path);
    if (!there) missing.push(e.path);
    else if (there.sha256 !== e.sha256 || there.bytes !== e.bytes) changed.push(e.path);
  }
  const extra = target.entries.filter((e) => !want.has(e.path)).map((e) => e.path);
  return { missing, extra, changed };
}

export const manifestsMatch = (d: ManifestDiff): boolean =>
  d.missing.length === 0 && d.extra.length === 0 && d.changed.length === 0;

export interface CopyReport {
  files: number;
  bytes: number;
  skipped: string[];
  source: Manifest;
  target: Manifest;
  diff: ManifestDiff;
  /** True only when both manifests match and nothing was left behind (or `allowSkips` said that is fine). */
  ok: boolean;
}

/** `path` with its deepest existing ancestor resolved through symlinks. */
function realish(path: string): string {
  const abs = resolve(path);
  const rest: string[] = [];
  let at = abs;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return abs;
      rest.push(at.slice(up.length + 1));
      at = up;
    }
  }
}

/** Throw when a path that already exists under `dst` for any entry is a symlink: a write would go through it. */
function refuseTargetLinks(dst: string, paths: string[]): void {
  const isLink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (isLink(dst)) throw new Error("the target is a symlink");
  for (const rel of paths) {
    let at = dst;
    for (const part of rel.split("/")) {
      at = join(at, part);
      if (isLink(at)) throw new Error(`the target holds a symlink at ${rel}`);
    }
  }
}

/**
 * Copy `from`'s regular files into `to`, then hash both ends and compare.
 * Refuses, before writing anything, a target nested in the source (or the
 * reverse) once symlinks are resolved, and a target that holds a symlink on
 * any path it would write. Files left behind (symlinks, devices) make `ok`
 * false unless `allowSkips` is set.
 */
export function copyWithManifest(from: string, to: string, opts: { allowSkips?: boolean } = {}): CopyReport {
  if (!lstatSync(from).isDirectory()) throw new Error("the source is not a directory");
  const src = realpathSync(from);
  const dst = realish(to);
  if (src === dst || dst.startsWith(src + sep) || src.startsWith(dst + sep)) {
    throw new Error("the source and the target must be separate directories");
  }
  const source = buildManifest(src);
  refuseTargetLinks(resolve(to), source.entries.map((e) => e.path));
  mkdirSync(dst, { recursive: true });
  for (const e of source.entries) {
    const out = join(dst, e.path);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(join(src, e.path), out);
  }
  const target = buildManifest(dst);
  const diff = compareManifests(source, target);
  return {
    files: source.entries.length,
    bytes: source.entries.reduce((n, e) => n + e.bytes, 0),
    skipped: source.skipped,
    source,
    target,
    diff,
    ok: manifestsMatch(diff) && (opts.allowSkips === true || source.skipped.length === 0),
  };
}
