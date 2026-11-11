/**
 * How often this forge has started, and how many of those starts followed
 * a process that never said goodbye (#3708). A crash — Bun's own segfault,
 * the kernel's OOM kill — leaves no line in the log saying so; the next
 * boot is the only witness, so it is the one that counts.
 *
 * `boots.json` under the data directory holds the running total and the
 * last {@link KEPT} starts, each with whether it exited cleanly. A start is
 * written unclean at boot and marked clean on the way out (`close` in
 * `main.ts`). An unclean start that is not this one is a crash — or a
 * release's old process still draining beside this one, which marks itself
 * clean when it goes, so the count is read live and settles back.
 *
 * Plain JSON written by rename: two processes overlap only during a
 * release, and each writes twice in its life.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Starts remembered one by one; the total keeps counting past them. */
export const KEPT = 50;

interface Start {
  readonly id: string;
  /** When it started, ms since the epoch. */
  readonly at: number;
  clean: boolean;
}

interface Ledger {
  total: number;
  starts: Start[];
  /** When the very first start happened, ms; kept when the oldest of `starts` is trimmed. Absent in older ledgers. */
  firstAt?: number;
}

/** What the ledger says, from this process's point of view. */
export interface BootCounts {
  /** Every start this data directory has seen, this one included. */
  readonly boots: number;
  /** Starts after the first: releases and crashes alike. */
  readonly restarts: number;
  /** Earlier starts (of the last {@link KEPT}) that never exited cleanly. */
  readonly unclean: number;
}

const file = (dataDir: string): string => join(dataDir, "boots.json");

function read(dataDir: string): Ledger {
  try {
    const raw: unknown = JSON.parse(readFileSync(file(dataDir), "utf8"));
    if (typeof raw !== "object" || raw === null) return { total: 0, starts: [] };
    const r = raw as { total?: unknown; starts?: unknown };
    const starts = Array.isArray(r.starts)
      ? r.starts.filter(
          (s): s is Start =>
            typeof s === "object" &&
            s !== null &&
            typeof (s as Start).id === "string" &&
            typeof (s as Start).at === "number" &&
            typeof (s as Start).clean === "boolean",
        )
      : [];
    const total =
      typeof r.total === "number" && Number.isSafeInteger(r.total) && r.total >= starts.length
        ? r.total
        : starts.length;
    const firstAt = typeof (raw as { firstAt?: unknown }).firstAt === "number" ? (raw as { firstAt: number }).firstAt : undefined;
    return firstAt === undefined ? { total, starts } : { total, starts, firstAt };
  } catch {
    return { total: 0, starts: [] };
  }
}

function write(dataDir: string, ledger: Ledger): void {
  const tmp = `${file(dataDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger));
  renameSync(tmp, file(dataDir));
}

/** Counts as the process `id` sees them. */
function countsOf(ledger: Ledger, id: string): BootCounts {
  return {
    boots: ledger.total,
    restarts: Math.max(0, ledger.total - 1),
    unclean: ledger.starts.filter((s) => s.id !== id && !s.clean).length,
  };
}

/** This process's start, once `recordBoot` has written it. */
let thisStart = "";

/** Write this start into the ledger. Never throws: a ledger is not worth a boot. */
export function recordBoot(
  dataDir: string,
  id: string = randomUUID(),
  now = Date.now(),
): BootCounts {
  thisStart = id;
  const ledger = read(dataDir);
  // An older ledger that never trimmed still knows its first start; one that did, only from here.
  ledger.firstAt ??= ledger.starts[0]?.at ?? now;
  ledger.total += 1;
  ledger.starts = [...ledger.starts, { id, at: now, clean: false }].slice(-KEPT);
  try {
    write(dataDir, ledger);
  } catch {
    // a read-only data directory counts nothing, and boots anyway
  }
  return countsOf(ledger, id);
}

/** Mark start `id` as having exited cleanly. */
export function recordCleanExit(dataDir: string, id = thisStart): void {
  const ledger = read(dataDir);
  const start = ledger.starts.find((s) => s.id === id);
  if (start === undefined || start.clean) return;
  start.clean = true;
  try {
    write(dataDir, ledger);
  } catch {
    // nothing to be done on the way out
  }
}

/** The ledger as start `id` reads it now. */
export function bootCounts(dataDir: string, id = thisStart): BootCounts {
  return countsOf(read(dataDir), id);
}

/** How long a new forge's first start is watched for crashes and kills (#11155). */
export const FIRST_MINUTES_MS = 10 * 60_000;

/** An unclean first-minutes start stops counting this long after it happened, so the alarm it raised clears. */
export const FIRST_MINUTES_MEMORY_MS = 60 * 60_000;

/**
 * Starts that never exited cleanly within `windowMs` of the forge's first
 * start (`firstAt`, which outlives the trimming of `starts` to {@link KEPT})
 * and less than `memoryMs` ago; null when this directory has no ledger. Read
 * from outside: a parent reads its child's.
 *
 * The newest start is left out: it may still be running, and from outside it
 * cannot be told from one that crashed. So a crash with no start after it is
 * counted only once the next start is written (a sleeping child's next wake).
 */
export function uncleanInFirstMinutes(dataDir: string, windowMs = FIRST_MINUTES_MS, now = Date.now(), memoryMs = FIRST_MINUTES_MEMORY_MS): number | null {
  const ledger = read(dataDir);
  const firstAt = ledger.firstAt ?? ledger.starts[0]?.at;
  if (firstAt === undefined) return null;
  return ledger.starts.slice(0, -1).filter((s) => !s.clean && s.at - firstAt <= windowMs && now - s.at < memoryMs).length;
}
