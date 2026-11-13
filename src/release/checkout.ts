/**
 * A landed commit as a release candidate: its tree written into
 * `releases/<sha>/` under the data directory, then asked whether it can boot
 * (`--preflight`, #1674). Nothing is swapped here; this only proves the tree
 * and keeps the last few.
 *
 * Idempotent: a sha already checked out is not written again. The tree is
 * exported beside its final place and renamed in, so a killed run leaves no
 * half-written `releases/<sha>/` for the next one to trust.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { exportTree } from "../apps/checkout.ts";
import { childEnv } from "../apps/process.ts";
import { isSafeOid } from "../git/guard.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const DEFAULT_KEEP = 5;
const PREFLIGHT_MS = 120_000;
/** A staging directory untouched this long was left by a killed run. */
const PARTIAL_STALE_MS = 10 * 60 * 1000;

export const releasesRoot = (dataDir: string): string => join(dataDir, "releases");

export const releaseDir = (dataDir: string, sha: string): string =>
  join(releasesRoot(dataDir), sha);

/** Write `sha`'s tree to its release directory; returns the directory. */
export async function checkoutRelease(
  dataDir: string,
  bareDir: string,
  sha: string,
): Promise<Result<string, string>> {
  if (!isSafeOid(sha) || sha.length !== 40) return err("not a commit id");
  const target = releaseDir(dataDir, sha);
  if (existsSync(target)) {
    // Touched, so it is the newest and pruning keeps it.
    const now = new Date();
    utimesSync(target, now, now);
    return ok(target);
  }
  const root = releasesRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.${sha}.partial`);
  try {
    const exported = await exportTree(bareDir, sha, staging);
    if (!exported.ok) return exported;
    renameSync(staging, target);
    return ok(target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Remove all but the `keep` newest releases, and `keep` is at least one; the
 * commits in `protect` (the landed one, the running one, the keeper's
 * rollback target) stay however old. Returns what went.
 */
export function pruneReleases(dataDir: string, keep: number, protect: readonly string[]): string[] {
  const root = releasesRoot(dataDir);
  if (!existsSync(root)) return [];
  const limit = Math.max(1, Math.floor(keep));
  const found = readdirSync(root)
    .filter((name) => /^[0-9a-f]{40}$/.test(name))
    .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : 1));
  const kept = new Set(found.slice(0, limit).map((r) => r.name));
  for (const sha of protect) kept.add(sha);
  const gone: string[] = [];
  for (const { name } of found) {
    if (kept.has(name)) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    gone.push(name);
  }
  // A partial export left by a killed run. One younger than the bound may be
  // another landing's checkout still writing: leave it.
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".partial")) continue;
    const path = join(root, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > PARTIAL_STALE_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Renamed into place between the listing and the look.
    }
  }
  return gone;
}

export type Verdict = { ok: boolean; line: string };

/** Run the release's own `--preflight` against this forge's data directory. */
export async function preflightRelease(dir: string, dataDir: string): Promise<Verdict> {
  const entry = join(dir, "src", "main.ts");
  if (!existsSync(entry)) return { ok: false, line: "preflight failed: the tree has no src/main.ts" };
  const proc = Bun.spawn([process.execPath, entry, "--preflight"], {
    cwd: dir,
    env: childEnv({ FORGE_DATA: dataDir, FORGE_APP_URL: "" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), PREFLIGHT_MS);
  try {
    const [out, errText, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const line =
      `${out}\n${errText}`
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .pop() ?? "";
    if (code === 0) return { ok: true, line: line || "preflight ok" };
    return { ok: false, line: (line || `preflight failed: exit ${code}`).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
