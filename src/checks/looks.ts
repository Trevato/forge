/**
 * The looks a check recorded web vitals for: one file beside the run's log,
 * `runs/<id>.vitals.json`, a JSON array of `{look, entries}` (the
 * `largest-contentful-paint`, `layout-shift` and `longtask` entries as the
 * page recorded them) or `{look, skipped}` (why there are none, e.g.
 * `no browser`). The browser half of #2983 writes it; both the run page and
 * the terminal read it here, so they never disagree. Whatever is in the file
 * is untrusted: anything of the wrong shape is dropped, never guessed at.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LookVitals } from "./summary.ts";
import { runsRoot } from "../runs/log.ts";

export const looksPath = (dataDir: string, runId: string): string =>
  join(runsRoot(dataDir), `${runId}.vitals.json`);

const MAX_BYTES = 1024 * 1024;
const MAX_LOOKS = 20;
const MAX_WORDS = 80;

const words = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, MAX_WORDS) : null;

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
    else if (rec.entries && typeof rec.entries === "object" && !Array.isArray(rec.entries))
      out.push({ look, entries: rec.entries });
  }
  return out;
}

/** The run's recorded looks; none when no file, an oversized file or bad JSON. */
export function readLooks(dataDir: string, runId: string): LookVitals[] {
  const path = looksPath(dataDir, runId);
  try {
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) return [];
    return parseLooks(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}
