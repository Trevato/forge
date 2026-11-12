/**
 * The machine now, as one point: the pod's CPU and memory from its cgroup
 * v2 (`cpu.stat`, `memory.current`) and, when readable, the node's memory
 * (`meminfo`) and 1-min load (`loadavg`). `root` is the filesystem root
 * (`/` in production), so a test points it at a temp dir holding
 * `sys/fs/cgroup/…` and `proc/…`. Pure: no timer, no storage, never throws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `/proc/stat` counts in USER_HZ, 100 a second on every Linux the forge runs on. */
const USER_HZ = 100;

const finite = (n: number) => (Number.isFinite(n) && n >= 0 ? n : null);

/** `usage_usec` from a cgroup v2 `cpu.stat`, µs of CPU since the cgroup began. */
export function parseCpuStat(text: string | null): number | null {
  const m = text === null ? null : /^usage_usec (\d+)$/m.exec(text);
  return m ? finite(Number(m[1])) : null;
}

/** Busy µs from one `/proc/stat` line's tick fields: user nice system irq softirq steal (guest is inside user). */
function busyUsec(fields: string): number | null {
  const f = fields.trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null;
  const busy = f[0]! + f[1]! + f[2]! + (f[5] ?? 0) + (f[6] ?? 0) + (f[7] ?? 0);
  return (busy * 1_000_000) / USER_HZ;
}

/** Busy CPU time of the whole node from `/proc/stat`'s `cpu` line, µs. */
export function parseProcStat(text: string | null): number | null {
  const m = text === null ? null : /^cpu +(.*)$/m.exec(text);
  return m ? busyUsec(m[1]!) : null;
}

/** Busy time of each logical CPU from `/proc/stat`'s `cpu<n>` lines, µs, in CPU order. */
export function parseProcStatCpus(text: string | null): { id: number; busyUsec: number }[] {
  const out: { id: number; busyUsec: number }[] = [];
  for (const m of text?.matchAll(/^cpu(\d+) +(.*)$/gm) ?? []) {
    const busy = busyUsec(m[2]!);
    if (busy !== null) out.push({ id: Number(m[1]), busyUsec: busy });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A logical CPU's target: `cpu:` and its number, zero-padded to three digits so a board lists them in order. */
export const cpuTarget = (id: number) => `cpu:${String(id).padStart(3, "0")}`;

/** Memory in use on the node, bytes: `MemTotal − MemAvailable` (kB × 1024). */
export function parseMeminfo(text: string | null): number | null {
  if (text === null) return null;
  const total = /^MemTotal:\s+(\d+) kB$/m.exec(text);
  const avail = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return total && avail ? finite((Number(total[1]) - Number(avail[1])) * 1024) : null;
}

/** The 1-min load average: the first field of `/proc/loadavg`. */
export function parseLoadavg(text: string | null): number | null {
  const first = text?.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : finite(Number(first));
}

/** Cumulative counters and gauges at one instant; each is null when its file is not readable. */
type MachinePoint = {
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

/** A point from the cgroup and /proc directories given, null where a file is not readable. */
export function readPoint(cgroup: string, proc: string): MachinePoint {
  const mem = read(join(cgroup, "memory.current"));
  return {
    cpuUsec: parseCpuStat(read(join(cgroup, "cpu.stat"))),
    memoryBytes: mem !== null && /^\d+\s*$/.test(mem) ? Number(mem) : null,
    nodeMemoryBytes: parseMeminfo(read(join(proc, "meminfo"))),
    load: parseLoadavg(read(join(proc, "loadavg"))),
  };
}

/** The node's busy CPU time and each logical CPU's, from `proc`/stat; null and empty when it is not readable. */
export function readCpus(proc: string): { nodeUsec: number | null; cpus: { id: number; busyUsec: number }[] } {
  const stat = read(join(proc, "stat"));
  return { nodeUsec: parseProcStat(stat), cpus: parseProcStatCpus(stat) };
}

/** The series whose file is not readable under these directories, each with the file that would have said it. */
export function unreadable(cgroup: string, proc: string): string[] {
  const files: [string, string][] = [
    ["forge cpu_cores", join(cgroup, "cpu.stat")],
    ["forge memory_bytes", join(cgroup, "memory.current")],
    ["node cpu_cores", join(proc, "stat")],
    ["node memory_bytes", join(proc, "meminfo")],
    ["node load", join(proc, "loadavg")],
  ];
  return files.filter(([, file]) => read(file) === null).map(([series, file]) => `${series}: ${file} is not readable here`);
}
