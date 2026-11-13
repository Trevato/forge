/**
 * The Flow dialog's CPU-stop lines (#11904), the terminal door of /flow's
 * block (`web/pages/flow-cpu.ts`): the hour's checks stopped for CPU, then the
 * pulls closed unmerged after such a stop, one per line, to queue again.
 * Plain data in (`cpuStops`, `cpuClosedPulls`), lines out; quiet says nothing.
 */

import type { CpuClosedPull } from "../../flow/cpu_closed.ts";
import { truncate } from "../term/width.ts";

export function cpuStopLines(stopped: number, closed: readonly CpuClosedPull[], inner: number): string[] {
  if (stopped === 0 && closed.length === 0) return [];
  return [
    "",
    ...(stopped === 0 ? [] : [truncate(`${String(stopped)} ${stopped === 1 ? "check" : "checks"} stopped for CPU in the last hour.`, inner)]),
    ...(closed.length === 0
      ? []
      : ["Closed unmerged after a CPU stop, to queue again:", ...closed.map((p) => truncate(`  ${p.repo} #${String(p.number)}`, inner))]),
  ];
}
