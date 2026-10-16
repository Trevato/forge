/**
 * The machine now, as one point: the pod's CPU and memory from its cgroup
 * v2 (`cpu.stat`, `memory.current`) and, when readable, the node's memory
 * (`meminfo`) and 1-min load (`loadavg`). `root` is the filesystem root
 * (`/` in production), so a test points it at a temp dir holding
 * `sys/fs/cgroup/…` and `proc/…`. Pure: no timer, no storage, never throws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCpuStat, parseLoadavg, parseMeminfo } from "./sampler.ts";

/** Cumulative counters and gauges at one instant; each is null when its file is not readable. */
export type MachinePoint = {
  /** Pod CPU, µs since the cgroup began: a rate needs two points. */
  cpuUsec: number | null;
  /** Pod memory, bytes. */
  memoryBytes: number | null;
  /** Node memory in use, bytes. */
  nodeMemoryBytes: number | null;
  /** Node 1-min load average. */
  load: number | null;
};

export type Machine = { ok: true; point: MachinePoint } | { ok: false; reason: string };

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A point from whatever is readable under `root`, or the reason nothing is. */
export function readMachine(root: string): Machine {
  try {
    const cgroup = join(root, "sys/fs/cgroup");
    const proc = join(root, "proc");
    const mem = read(join(cgroup, "memory.current"));
    const point: MachinePoint = {
      cpuUsec: parseCpuStat(read(join(cgroup, "cpu.stat"))),
      memoryBytes: mem !== null && /^\d+\s*$/.test(mem) ? Number(mem) : null,
      nodeMemoryBytes: parseMeminfo(read(join(proc, "meminfo"))),
      load: parseLoadavg(read(join(proc, "loadavg"))),
    };
    if (Object.values(point).every((v) => v === null)) return { ok: false, reason: "no cgroup or /proc file is readable here" };
    return { ok: true, point };
  } catch {
    return { ok: false, reason: "the machine could not be read" };
  }
}
