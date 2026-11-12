/**
 * A check the cell's watch stopped for CPU (#11617): the machine's failure,
 * not the pull's. The first such stop of a head is queued again once on its
 * own, as the cancelled attempt `CPU_STOP_SUMMARY` says, so it never reads
 * red and its builder is sent no `check_failed`; a second stop in a row is
 * reported as any red is, so a check that truly spins cannot loop.
 */

import type { Database } from "bun:sqlite";
import { stoppedForCpu } from "../apps/contain.ts";
import { CPU_STOP_SUMMARY, cpuStopBefore, requeueCheck, type Run } from "../core/runs.ts";

/** The cancelled attempt and its retry when `error` is a first CPU stop of a running check; undefined when it is reported. */
export function requeueCpuStop(
  db: Database,
  run: Run,
  error: string,
): { cancelled: Run; again: Run } | undefined {
  if (run.kind !== "check" || !stoppedForCpu(error) || cpuStopBefore(db, run)) return undefined;
  return requeueCheck(db, run.id, undefined, CPU_STOP_SUMMARY);
}
