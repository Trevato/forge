/**
 * Who serves the port now (#8042). A swapped release is started by the
 * process it replaces, so it is not the launcher's child; the launcher
 * (`launch.ts`) would see its own child drain and exit, and a container whose
 * first process exits takes the release with it. So the process that took
 * over writes `release/serving.json` ({pid, sha}), and the launcher stays up
 * while that pid lives and passes it SIGTERM when it is told to stop. The
 * launcher clears the file on start, so a pid is only ever one this
 * container started. Node built-ins only, as `launch.ts` is.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Serving {
  readonly pid: number;
  readonly sha: string;
}

const file = (dataDir: string): string => join(dataDir, "release", "serving.json");

export function writeServing(dataDir: string, s: Serving): void {
  const path = file(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, path);
}

export function readServing(dataDir: string): Serving | undefined {
  try {
    const v = JSON.parse(readFileSync(file(dataDir), "utf8")) as { pid?: unknown; sha?: unknown };
    if (!Number.isInteger(v.pid) || (v.pid as number) <= 1 || typeof v.sha !== "string") return undefined;
    return { pid: v.pid as number, sha: v.sha };
  } catch {
    return undefined;
  }
}

export function clearServing(dataDir: string): void {
  if (existsSync(file(dataDir))) rmSync(file(dataDir), { force: true });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pass `signal` to the process that took over from `ownPid`, if one lives. */
export function signalServing(dataDir: string, signal: NodeJS.Signals, ownPid?: number): void {
  const s = readServing(dataDir);
  if (s === undefined || s.pid === ownPid || !alive(s.pid)) return;
  try {
    process.kill(s.pid, signal);
  } catch {
    // Gone between the look and the signal.
  }
}

/** Return once the process serving is `ownPid` again or none lives: the swapped release is gone. */
export async function follow(dataDir: string, ownPid: number, pollMs = 1000): Promise<void> {
  for (;;) {
    const s = readServing(dataDir);
    if (s === undefined || s.pid === ownPid || !alive(s.pid)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
