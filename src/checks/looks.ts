/**
 * The looks a check recorded web vitals for: one file beside the run's log,
 * `runs/<id>.vitals.json`, a JSON array of `{look, entries}` (the
 * `largest-contentful-paint`, `layout-shift` and `longtask` entries as the
 * page recorded them) or `{look, skipped}` (why there are none, e.g.
 * `no browser`). The browser half of #2983 writes it; both the run page and
 * the terminal read it here, so they never disagree. Whatever is in the file
 * is untrusted: anything of the wrong shape is dropped, never guessed at.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LookVitals, PageSize } from "./summary.ts";
import { runsRoot } from "../runs/log.ts";

export const looksPath = (dataDir: string, runId: string): string =>
  join(runsRoot(dataDir), `${runId}.vitals.json`);

/**
 * Looks are filed under the commit they picture, beside the run files, so
 * they are there whenever the commit's check is: before it exists, after it
 * is queued, or past any page of recent runs. A run's own file wins.
 */
export const commitLooksPath = (
  dataDir: string,
  repoId: string,
  commitOid: string,
): string => join(runsRoot(dataDir), `commit-${repoId}-${commitOid}.vitals.json`);

const SAFE = /^[0-9A-Za-z]{1,64}$/;

const MAX_BYTES = 1024 * 1024;
const MAX_LOOKS = 20;
const MAX_WORDS = 80;

const words = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, MAX_WORDS) : null;

const whole = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e6;

function parseSize(v: unknown): PageSize | undefined {
  if (!v || typeof v !== "object") return undefined;
  const { scrollWidth, scrollHeight, innerWidth, innerHeight } = v as Record<string, unknown>;
  return whole(scrollWidth) && whole(scrollHeight) && whole(innerWidth) && whole(innerHeight)
    ? { scrollWidth, scrollHeight, innerWidth, innerHeight }
    : undefined;
}

/** Plain data in: the parsed file's value, narrowed to the looks it validly holds. */
export function parseLooks(raw: unknown): LookVitals[] {
  if (!Array.isArray(raw)) return [];
  const out: LookVitals[] = [];
  for (const item of raw.slice(0, MAX_LOOKS)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const look = words(rec.look);
    if (look === null) continue;
    const skipped = words(rec.skipped);
    if (skipped !== null) out.push({ look, skipped });
    else if (rec.entries && typeof rec.entries === "object" && !Array.isArray(rec.entries)) {
      const size = parseSize(rec.size);
      out.push({ look, entries: rec.entries, ...(size === undefined ? {} : { size }) });
    }
  }
  return out;
}

function readFile(path: string): LookVitals[] {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) return [];
    return parseLooks(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

/** What `readLooks` needs of a run: its id and the commit it checks. */
export interface LooksOf {
  readonly id: string;
  readonly repoId: string;
  readonly commitOid: string;
}

/**
 * The run's recorded looks: its own file, else those filed under its
 * commit; none when no file, an oversized file or bad JSON.
 */
export function readLooks(dataDir: string, run: LooksOf): LookVitals[] {
  const own = readFile(looksPath(dataDir, run.id));
  if (own.length > 0 || !SAFE.test(run.commitOid) || !SAFE.test(run.repoId))
    return own;
  return readFile(commitLooksPath(dataDir, run.repoId, run.commitOid));
}

/**
 * File a commit's looks, replacing any earlier set for it: written whole
 * beside the log and moved in, so a reader never sees half of it. What
 * `readLooks` would drop is not written, and a set with nothing left removes
 * the earlier file, so a stale table never outlives its replacement.
 */
export function writeCommitLooks(
  dataDir: string,
  repoId: string,
  commitOid: string,
  looks: readonly LookVitals[],
): void {
  if (!SAFE.test(commitOid) || !SAFE.test(repoId)) return;
  const path = commitLooksPath(dataDir, repoId, commitOid);
  const kept = parseLooks(looks);
  if (kept.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(runsRoot(dataDir), { recursive: true });
  const side = `${path}.${process.pid}.tmp`;
  writeFileSync(side, JSON.stringify(kept));
  renameSync(side, path);
}
