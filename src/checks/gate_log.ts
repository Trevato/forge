/**
 * Every gate keeps its log: per repository, the last 20 gates, each as one
 * small file under `checks/gates/<owner>/<name>/` holding its per-file
 * results and the last 200 lines of its output, so a red gate is read
 * without running the pull again.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileResults, type FileResult } from "./gate_last.ts";

export const KEEP_GATES = 20;
export const TAIL_LINES = 200;

export type KeptGate = {
  id: string;
  at: number;
  commit: string;
  ok: boolean;
  files: Record<string, FileResult>;
  tail: string[];
};

const ID = /^\d{13}-[0-9a-f]{4,40}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export const gateId = (now: number, commit: string): string =>
  `${String(Math.max(0, Math.trunc(now))).padStart(13, "0")}-${commit.toLowerCase().slice(0, 12)}`;

const dirOf = (dataDir: string, owner: string, name: string): string | undefined =>
  SEGMENT.test(owner) && SEGMENT.test(name) && owner !== ".." && name !== ".."
    ? join(dataDir, "checks", "gates", owner, name)
    : undefined;

/** Keep one gate's record and drop all but the newest 20. Returns its id. */
export function keepGateLog(
  dataDir: string,
  repo: string,
  commit: string,
  ok: boolean,
  lines: readonly string[],
  now: number,
): string | undefined {
  const [owner = "", name = ""] = repo.split("/");
  const dir = dirOf(dataDir, owner, name);
  const id = gateId(now, commit);
  if (dir === undefined || !ID.test(id)) return undefined;
  const kept: KeptGate = {
    id,
    at: now,
    commit: id.slice(14),
    ok,
    files: fileResults(lines),
    tail: lines.slice(-TAIL_LINES),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(kept));
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && ID.test(f.slice(0, -5)))
    .sort();
  for (const old of ids.slice(0, Math.max(0, ids.length - KEEP_GATES)))
    rmSync(join(dir, old), { force: true });
  return id;
}

export function readGateLog(
  dataDir: string,
  owner: string,
  name: string,
  id: string,
): KeptGate | undefined {
  const dir = dirOf(dataDir, owner, name);
  if (dir === undefined || !ID.test(id)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as KeptGate;
    return Array.isArray(parsed.tail) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
