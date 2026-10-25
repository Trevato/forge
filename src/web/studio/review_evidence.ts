/**
 * A pull's diff stat for the `/review` row: files changed, additions and
 * deletions, kept per (base oid, head oid). A request only reads the cache;
 * a miss is computed in the background, at most `LIMIT` at once, by the app
 * that asked, so `app.close()` (its `closing` signal) kills the git processes
 * and starts no more. Only a successful stat is kept: a failure is asked
 * again, but not before `RETRY_MS` has passed, so a pull whose diff always
 * fails cannot turn each visit into a git process.
 */

import { pullDir, type Pull } from "../../core/pulls.ts";
import type { App } from "../../app.ts";
import { runGit } from "../../git/env.ts";
import { isSafeOid } from "../../git/guard.ts";

export interface DiffStat {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

const LIMIT = 4;
const KEPT_MAX = 500;
const RETRY_MS = 60_000;

interface Work {
  readonly kept: Map<string, DiffStat>;
  readonly queued: Map<string, () => Promise<void>>;
  readonly running: Set<Promise<void>>;
  /** Keys queued or running: one git per pair, however many visits. */
  readonly inflight: Set<string>;
  /** Keys whose stat failed, until when. */
  readonly failed: Map<string, number>;
}

// Per app, never per module: nothing exists until a request asks, and a
// closed app takes its work with it.
const works = new WeakMap<App, Work>();

/** `git diff --numstat` lines to totals; a binary file counts as a file with no lines. */
export function parseNumstat(text: string): DiffStat {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (m === null) continue;
    files++;
    additions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
  }
  return { files, additions, deletions };
}

function workOf(app: App): Work {
  let w = works.get(app);
  if (w === undefined) works.set(app, (w = { kept: new Map(), queued: new Map(), running: new Set(), inflight: new Set(), failed: new Map() }));
  return w;
}

function pump(app: App, w: Work): void {
  while (!app.closing.signal.aborted && w.running.size < LIMIT) {
    const next = w.queued.entries().next();
    if (next.done) return;
    const [key, job] = next.value;
    w.queued.delete(key);
    const p: Promise<void> = job()
      .catch(() => {})
      .finally(() => {
        w.running.delete(p);
        pump(app, w);
      });
    w.running.add(p);
  }
}

/**
 * The stat if it is kept; "failed" while a recent attempt failed; otherwise
 * "loading", with the computation started in the background (once per pair).
 * Never waits on git.
 */
export function diffStatFor(
  app: App,
  repo: { ownerName: string; name: string },
  pull: Pick<Pull, "baseOid" | "headOid" | "sealed" | "crossRepo" | "headRepoId" | "baseBranch">,
): DiffStat | "loading" | "failed" {
  const w = workOf(app);
  const key = `${pull.baseOid}:${pull.headOid}`;
  const kept = w.kept.get(key);
  if (kept !== undefined) return kept;
  if (!isSafeOid(pull.baseOid) || !isSafeOid(pull.headOid)) return "failed";
  const failedUntil = w.failed.get(key);
  if (failedUntil !== undefined) {
    if (failedUntil > Date.now()) return "failed";
    w.failed.delete(key);
  }
  if (app.closing.signal.aborted || w.inflight.has(key)) return "loading";
  w.inflight.add(key);
  w.queued.set(key, async () => {
    try {
      await compute(app, w, key, repo, pull);
    } catch {
      if (!app.closing.signal.aborted) w.failed.set(key, Date.now() + RETRY_MS);
    } finally {
      w.inflight.delete(key);
    }
  });
  pump(app, w);
  return "loading";
}

async function compute(
  app: App,
  w: Work,
  key: string,
  repo: { ownerName: string; name: string },
  pull: Pick<Pull, "baseOid" | "headOid" | "sealed" | "crossRepo" | "headRepoId" | "baseBranch">,
): Promise<void> {
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const out = await runGit(["diff", "--numstat", "--no-color", "--no-renames", `${pull.baseOid}...${pull.headOid}`, "--"], {
    cwd: dir,
    timeoutMs: 30_000,
    signal: app.closing.signal,
  });
  if (app.closing.signal.aborted) return;
  if (!out.ok) {
    w.failed.set(key, Date.now() + RETRY_MS);
    return;
  }
  keep(w, key, parseNumstat(out.value));
}

function keep(w: Work, key: string, stat: DiffStat): void {
  if (w.kept.size >= KEPT_MAX) w.kept.delete(w.kept.keys().next().value!);
  w.kept.set(key, stat);
}

/** Seed the cache for a (base, head) pair: for tests that need a known size without a repository. */
export function rememberStat(app: App, baseOid: string, headOid: string, stat: DiffStat): void {
  keep(workOf(app), `${baseOid}:${headOid}`, stat);
}

/** `3 files changed, +40 −7`. */
export function sizeLine(s: DiffStat): string {
  return `${s.files} ${s.files === 1 ? "file" : "files"} changed, +${s.additions} −${s.deletions}`;
}

/** Resolves when the app's background stats have all settled: for tests. */
export async function settled(app: App): Promise<void> {
  const w = works.get(app);
  while (w !== undefined && w.running.size > 0) await Promise.allSettled([...w.running]);
}
