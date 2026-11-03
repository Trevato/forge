/**
 * A fetch of a head nobody here vetted (a read-only mirror's pull, #9011),
 * capped in bytes. git's fetch has no `maxInputSize` of its own, so it runs
 * into a throwaway bare repository beside the real one that borrows the
 * real one's objects (`objects/info/alternates`): only what is new lands
 * there. A watchdog kills the fetch once that passes the cap, and only a
 * fetch that finished under it has its objects moved into the repository
 * and is named by `ref`. Anything else leaves the repository as it was.
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { runGitCapture } from "./env.ts";
import { isSafeOid } from "./guard.ts";
import { resolveOid } from "./merge.ts";

export interface CappedFetch {
  /** The repository fetched into. */
  readonly dir: string;
  readonly url: string;
  /** The remote ref, e.g. `refs/pull/3/head`. */
  readonly from: string;
  /** The local ref it lands at, once it is under the cap. */
  readonly ref: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** The vetted, pinned env for the remote (`vettedEnv`). */
  readonly env: Record<string, string>;
}

export type CappedFetchResult =
  | { readonly ok: true; readonly oid: string }
  | { readonly ok: false; readonly reason: "too_large" | "failed" };

const WATCH_MS = 100;

/** Bytes under `root`, every file. */
async function bytesUnder(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const size = await stat(join(entry.parentPath, entry.name)).then((s) => s.size, () => 0);
    total += size;
  }
  return total;
}

/** Move every object file from `from` into `to`, keeping its path; one already there stays. */
async function migrate(from: string, to: string): Promise<void> {
  const entries = (await readdir(from, { recursive: true, withFileTypes: true })).filter(
    (e) => !join(e.parentPath, e.name).startsWith(join(from, "info")),
  );
  // Packs: the index after its pack, so no reader sees an index without one.
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(from.length + 1))
    .sort((a, b) => Number(a.endsWith(".idx")) - Number(b.endsWith(".idx")));
  for (const rel of files) {
    const target = join(to, rel);
    await mkdir(join(target, ".."), { recursive: true });
    if (await stat(target).then(() => true, () => false)) continue;
    await rename(join(from, rel), target);
  }
}

export async function cappedFetch(input: CappedFetch): Promise<CappedFetchResult> {
  const objects = join(input.dir, "objects");
  const scratch = await mkdtemp(join(input.dir, "incoming-"));
  const fresh = join(scratch, "objects");
  const abort = new AbortController();
  let tooLarge = false;
  const newBytes = async (): Promise<number> =>
    (await bytesUnder(fresh)) - (await bytesUnder(join(fresh, "info")));
  const watch = setInterval(() => {
    void newBytes().then((n) => {
      if (n > input.maxBytes && !abort.signal.aborted) {
        tooLarge = true;
        abort.abort();
      }
    });
  }, WATCH_MS);
  try {
    const made = await runGitCapture(["init", "--quiet", "--bare", scratch]);
    if (made.code !== 0) return { ok: false, reason: "failed" };
    await mkdir(join(fresh, "info"), { recursive: true });
    await Bun.write(join(fresh, "info", "alternates"), `${objects}\n`);
    const fetched = await runGitCapture(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--quiet",
        "--",
        input.url,
        `+${input.from}:refs/incoming`,
      ],
      { cwd: scratch, env: input.env, timeoutMs: input.timeoutMs, signal: abort.signal },
    );
    clearInterval(watch);
    if (tooLarge || (await newBytes()) > input.maxBytes) return { ok: false, reason: "too_large" };
    if (fetched.code !== 0) return { ok: false, reason: "failed" };
    const oid = await resolveOid(scratch, "refs/incoming");
    if (oid === undefined || !isSafeOid(oid)) return { ok: false, reason: "failed" };
    await migrate(fresh, objects);
    const named = await runGitCapture(["update-ref", input.ref, oid], { cwd: input.dir });
    return named.code === 0 ? { ok: true, oid } : { ok: false, reason: "failed" };
  } finally {
    clearInterval(watch);
    await rm(scratch, { recursive: true, force: true });
  }
}
