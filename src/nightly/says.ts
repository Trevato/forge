/**
 * What the nightly jobs did, in words: the lines the Resilience page and the
 * terminal's Resilience dialog both show, so a person sees that a night ran
 * and what it filed without reading a log. Plain data in, plain text out.
 */

import { JOBS } from "./jobs.ts";
import { type Last, readLast } from "./stamps.ts";

const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function nightlyLine(name: string, slot: { hour: number; minute: number }, last: Last | undefined): string {
  const at = `${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")} UTC`;
  if (last === undefined) return `${name}: has not run yet; its slot is ${at} each night.`;
  if (last.finishedAt === undefined) return `${name}: began ${when(last.startedAt)} and has not finished (or was cut short by a restart).`;
  return `${name}: ${when(last.startedAt)} to ${when(last.finishedAt)}, ${last.says}`;
}

export function nightlyLines(dataDir: string): string[] {
  return JOBS.map((job) => nightlyLine(job.name, job.slot, readLast(dataDir, job.name)));
}
