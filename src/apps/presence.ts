/**
 * Which forges are serving apps from this data directory right now (#4496).
 *
 * A forge with apps on writes `serving/<id>.json` — its host, pid and the
 * time — every `BEAT_MS`, and removes it once its apps are stopped. A new
 * forge reads the others: one that beat within `STALE_MS` (and, on this
 * host, whose pid still runs) is a predecessor still serving its copies of
 * the apps, the surge pod of a rollout. Only then is it worth being
 * unready while this forge's own copies start (`warmBehind`); a cold start
 * — a crash, an eviction, the first boot — has nobody serving in its
 * place, and is ready at once.
 *
 * Plain JSON written by rename, one file per process, so two forges never
 * write the same file.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { startWarming } from "../http/health.ts";
import type { Log } from "../kernel/log.ts";
import { during } from "../perf/jobs.ts";

export const BEAT_MS = 5_000;
/** Three beats missed: the forge that wrote it is gone. */
export const STALE_MS = 3 * BEAT_MS;

export interface Beat {
  readonly id: string;
  readonly host: string;
  readonly pid: number;
  /** ms since the epoch. */
  readonly at: number;
}

export interface Presence {
  /** Whether another forge is serving this data's apps this instant. */
  others(now?: number): boolean;
  /** Stop beating and remove this forge's file. Idempotent. */
  stop(): void;
}

const dirOf = (dataDir: string): string => join(dataDir, "serving");
const ID = /^[0-9a-f-]{36}$/;

function parse(raw: string): Beat | undefined {
  try {
    const b = JSON.parse(raw) as Partial<Beat>;
    if (
      typeof b.id === "string" && ID.test(b.id) &&
      typeof b.host === "string" && typeof b.pid === "number" && Number.isInteger(b.pid) &&
      typeof b.at === "number" && Number.isFinite(b.at)
    )
      return { id: b.id, host: b.host, pid: b.pid, at: b.at };
  } catch {
    // A torn or foreign file says nobody is there.
  }
  return undefined;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `beat` is a forge still serving, seen from `host` at `now`. */
export function alive(beat: Beat, now: number, host = hostname()): boolean {
  if (now - beat.at >= STALE_MS) return false;
  // On this host the pid settles it at once: a crash restarted in the same
  // pod is not waited for while its last beat ages out.
  return beat.host !== host || running(beat.pid);
}

/** Every other forge's beat on this data. */
export function beatsOf(dataDir: string, self?: string): Beat[] {
  let names: string[];
  try {
    names = readdirSync(dirOf(dataDir));
  } catch {
    return [];
  }
  const beats: Beat[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === `${self}.json`) continue;
    try {
      const beat = parse(readFileSync(join(dirOf(dataDir), name), "utf8"));
      if (beat !== undefined) beats.push(beat);
    } catch {
      // Removed between the listing and the read: gone.
    }
  }
  return beats;
}

/** Start beating for this forge; files long dead are removed on the way. */
export function takePresence(dataDir: string, beatMs = BEAT_MS): Presence {
  const self: Beat = { id: randomUUID(), host: hostname(), pid: process.pid, at: Date.now() };
  const dir = dirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const beat of beatsOf(dataDir, self.id))
    if (now - beat.at >= 10 * STALE_MS) rmSync(join(dir, `${beat.id}.json`), { force: true });
  const file = join(dir, `${self.id}.json`);
  const write = (): void => {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ ...self, at: Date.now() }));
      renameSync(`${file}.tmp`, file);
    } catch {
      // A full disk misses a beat; the next one tries again.
    }
  };
  write();
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => during("presence", write), beatMs);
  timer.unref?.();
  return {
    others: (at = Date.now()) => beatsOf(dataDir, self.id).some((b) => alive(b, at, self.host)),
    stop: () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
      rmSync(file, { force: true });
    },
  };
}

/**
 * Unready while this boot's apps start — only behind a forge still serving
 * them, and only while it still is: one that dies meanwhile ends the wait.
 */
export function warmBehind(log: Log, presence: Presence, starting: () => number): void {
  if (!presence.others()) return;
  startWarming(log, () => (presence.others() ? starting() : 0));
}
