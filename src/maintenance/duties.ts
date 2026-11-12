/**
 * What each maintenance duty (the nightly jobs and the radar) last did, one
 * line apiece: when it last ran in the UI's clock (UTC, as `nightly/says.ts`),
 * what it found, and "overdue" in plain words once it is past its period
 * plus a grace. Plain data in, plain data out; the page and the MCP read it.
 */

import { JOBS } from "../nightly/jobs.ts";
import { RADAR_NAME, RADAR_SLOT } from "../nightly/radar.ts";
import { readLast, type Last } from "../nightly/stamps.ts";
import type { Slot } from "../nightly/slots.ts";

const DAY = 86_400_000;
/** A night that began its slot may run long (the hunt is twenty half-hour slices): overdue only past this much more. */
export const GRACE_MS = 6 * 3_600_000;

export interface Duty {
  readonly name: string;
  /** "never" before the first run; otherwise the last start, `YYYY-MM-DD HH:MM UTC`. */
  readonly lastRun: string;
  /** What it found, one line; "nothing found" when it filed nothing. */
  readonly found: string;
  readonly overdue: boolean;
  /** What the row says after the name, without the overdue mark. */
  readonly detail: string;
  /** The row in words, the same in the terminal and in the MCP answer. */
  readonly says: string;
}

const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const oneLine = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return t === "" || /^(filed|found) nothing$/i.test(t) || /^read \d+ repositor(y|ies); filed nothing$/i.test(t) ? "nothing found" : t.slice(0, 160);
};

export function dutyOf(name: string, slot: Slot, last: Last | undefined, now: number): Duty {
  if (last === undefined) {
    const at = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")} UTC`;
    return { name, lastRun: "never", found: "nothing found", overdue: false, detail: `never run; its slot is ${at} each night`, says: `${name}: never run; its slot is ${at} each night.` };
  }
  const overdue = now > last.slot + DAY + GRACE_MS;
  const found = last.finishedAt === undefined ? "not finished" : oneLine(last.says);
  return {
    name,
    lastRun: when(last.startedAt),
    found,
    overdue,
    detail: `last ran ${when(last.startedAt)}; ${found}`,
    says: `${name}: last ran ${when(last.startedAt)}; ${found}${overdue ? "; overdue" : ""}.`,
  };
}

export function duties(dataDir: string, now: number = Date.now()): Duty[] {
  return [...JOBS.map((j) => ({ name: j.name as string, slot: j.slot })), { name: RADAR_NAME, slot: RADAR_SLOT }].map((d) =>
    dutyOf(d.name, d.slot, readLast(dataDir, d.name), now),
  );
}
