/**
 * A cell's memory cap, held by the kernel: each cell gets a cgroup v2 of
 * its own under the forge's, with `memory.max` set to the cell's memory
 * limit, so a cell that allocates past it is OOM-killed alone — never the
 * forge, never its neighbours (#2410). The watch in `apps/contain.ts`
 * still reads every cell once a second; this is the floor under it, for
 * a cell that allocates faster than a second's tick.
 *
 * It needs the forge's own cgroup delegated to it: cgroup v2, mounted
 * read-write, owned by the forge's user, with the memory controller
 * available. A container gets that from its runtime (a delegated
 * subtree, or a writable `/sys/fs/cgroup`); without it, cells are
 * watched only, and `cgroupHost()` says why (shown on /system).
 *
 * Layout under the forge's cgroup `R` (cgroup v2's "no internal
 * processes" rule: a cgroup that hands memory to children holds no
 * process of its own):
 *
 *   R/forge/         the forge and everything it starts outside a cell;
 *                    cpu.weight and io.weight 1000 against the cells' 100
 *   R/cells/c<n>/    one per cell: memory.max, memory.swap.max = 0,
 *                    memory.oom.group = 1 (the whole cell dies together);
 *                    pids.max the watch's process limit (#10518);
 *                    a step's cpu.weight and io.weight 10, below an app's
 *                    100, and cpu.max its declared cores (`apps/background.ts`)
 *   R/cells/c<n>/    one per crew run, too: no memory cap, weight 10 and
 *                    cpu.max of `FORGE_CREW_CPUS` cores — out of the
 *                    forge's own leaf, where only nice told them apart
 *
 * The weights are asked for where the cpu and io controllers are
 * delegated too, and never required: memory is what a cell must have.
 *
 * `FORGE_CELL_CGROUP` names `R` (an absolute path) or turns this `off`;
 * unset, `R` is `/sys/fs/cgroup` when the forge is at the root of its
 * cgroup namespace (`0::/` in `/proc/self/cgroup`: a container's own).
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type CgroupHost =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: string };

/** The cgroup a cell's process is in, open for the life of the cell. */
export interface CellCgroup {
  readonly dir: string;
  /** The cap, bytes (`memory.max`). */
  readonly maxBytes: number;
  /** How many times the kernel OOM-killed in it (`memory.events` `oom_kill`). */
  readonly oomKills: () => number;
  /** Whether the kernel holds its cores (`cpu.max` written): then a busy cell is throttled, never stopped. */
  readonly cpuCapped: boolean;
  /** Kill whatever is left and remove the cgroup, retrying while it empties. */
  readonly remove: () => void;
}

/** The forge's own leaf's `cpu.weight` and `io.weight`: ten times a cell's default 100. */
export const FORGE_WEIGHT = 1000;

/** A cell's place in the CPU and IO queue: its `cpu.weight` and `io.weight` (1–10000), and at most `cpus` cores (`cpu.max`). */
export interface CpuShare {
  readonly weight: number;
  readonly cpus?: number | undefined;
}

/** `cpu.max`'s period, µs: the kernel's default (cgroup-v2.rst, "cpu.max ... max 100000"). */
export const CPU_PERIOD_US = 100_000;

/**
 * `cpu.max` for `cpus` cores: "$MAX $PERIOD — the group may consume up to
 * $MAX in each $PERIOD duration" (cgroup-v2.rst), so 2 cores is
 * `200000 100000`. The kernel refuses a quota under 1 ms; that is the floor.
 */
export function cpuMax(cpus: number): string {
  return `${Math.max(1000, Math.round(cpus * CPU_PERIOD_US))} ${CPU_PERIOD_US}`;
}

let host: CgroupHost | undefined;
let nextCell = 1;

/** Whether cells get a kernel memory cap here, decided once (and the layout prepared). */
export function cgroupHost(): CgroupHost {
  host ??= prepare(cgroupRoot());
  return host;
}

/** The forge's own cgroup directory, or why there is none to use. */
export function cgroupRoot(
  env: string | undefined = process.env["FORGE_CELL_CGROUP"],
  self: () => string = () => readFileSync("/proc/self/cgroup", "utf8"),
): { ok: true; root: string } | { ok: false; reason: string } {
  if (env === "off") return { ok: false, reason: "FORGE_CELL_CGROUP=off" };
  if (env !== undefined && env !== "") {
    if (!env.startsWith("/") || env.split("/").includes(".."))
      return { ok: false, reason: `FORGE_CELL_CGROUP must be an absolute path, not ${JSON.stringify(env)}` };
    return { ok: true, root: env };
  }
  if (process.platform !== "linux") return { ok: false, reason: `no cgroups on ${process.platform}` };
  let text: string;
  try {
    text = self();
  } catch {
    return { ok: false, reason: "/proc/self/cgroup is unreadable" };
  }
  // cgroup v2 is the one line `0::<path>`; v1 has a line per controller.
  const line = text.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) return { ok: false, reason: "this host has no cgroup v2" };
  // At the root of its own cgroup namespace (a container), the cgroup is
  // the container's to divide. Anywhere else (a developer's login session)
  // it is shared with processes that are not the forge's: only when named.
  if (line.slice(3).trim() !== "/")
    return { ok: false, reason: "not at a cgroup namespace root; FORGE_CELL_CGROUP names a delegated cgroup" };
  return { ok: true, root: "/sys/fs/cgroup" };
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const words = (text: string | undefined): string[] => (text ?? "").trim().split(/\s+/).filter((w) => w !== "");

/**
 * Make `R/forge` and `R/cells` and give `cells` the memory controller,
 * moving the forge's processes out of `R` first. Idempotent: a forge that
 * restarts finds the layout standing, and removes the cells of a forge
 * that is gone — never those of one still draining its checks in a roll.
 */
export function prepare(
  found: { ok: true; root: string } | { ok: false; reason: string },
): CgroupHost {
  if (!found.ok) return found;
  const { root } = found;
  if (!words(read(join(root, "cgroup.controllers"))).includes("memory"))
    return { ok: false, reason: `${root} has no memory controller (cgroup v2 not delegated here)` };
  for (const file of ["", "cgroup.procs", "cgroup.subtree_control"])
    if (!writable(join(root, file)))
      return { ok: false, reason: `${root} is read-only to the forge (no delegated cgroup)` };
  try {
    if (!words(read(join(root, "cgroup.subtree_control"))).includes("memory")) {
      const leaf = join(root, "forge");
      mkdirSync(leaf, { recursive: true });
      // One pid per write: cgroupfs takes them one at a time.
      for (const pid of words(read(join(root, "cgroup.procs")))) {
        try {
          writeFileSync(join(leaf, "cgroup.procs"), pid);
        } catch {
          // gone between the read and the write, or a kernel thread
        }
      }
      writeFileSync(join(root, "cgroup.subtree_control"), "+memory");
    }
    const cells = join(root, "cells");
    mkdirSync(cells, { recursive: true });
    writeFileSync(join(cells, "cgroup.subtree_control"), "+memory");
    // A cell's process count is the kernel's too (`pids.max`, #10518), and
    // the forge outweighs every cell, a step less than an app (#3319).
    // Asked for, never required: without pids the watch still counts every
    // tick; without cpu or io, nice and SCHED_BATCH still hold.
    for (const controller of ["pids", "cpu", "io"]) {
      if (!words(read(join(root, "cgroup.controllers"))).includes(controller)) continue;
      try {
        for (const dir of [root, cells])
          if (!words(read(join(dir, "cgroup.subtree_control"))).includes(controller))
            writeFileSync(join(dir, "cgroup.subtree_control"), `+${controller}`);
        if (controller !== "pids")
          writeFileSync(join(root, "forge", `${controller}.weight`), `${controller === "io" ? "default " : ""}${FORGE_WEIGHT}`);
      } catch {
        // not delegated here, or the forge's leaf is elsewhere: the memory cap still holds
      }
    }
    for (const name of readdirSync(cells)) {
      const owner = /^c\d+-(\d+)$/.exec(name)?.[1];
      if (owner !== undefined && !alive(Number(owner))) removeDir(join(cells, name));
    }
  } catch (error) {
    return { ok: false, reason: `cannot lay out ${root}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, root };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill what is in a cell's cgroup and remove it; a few tries while the processes go. */
function removeDir(dir: string, tries = 10): void {
  try {
    if (existsSync(join(dir, "cgroup.kill"))) writeFileSync(join(dir, "cgroup.kill"), "1");
  } catch {
    // already empty, or the kernel has no cgroup.kill (before 5.14)
  }
  try {
    rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || tries <= 1) return;
    // EBUSY: a killed process is not reaped yet.
    setTimeout(() => removeDir(dir, tries - 1), 200).unref();
  }
}

/**
 * Whether cells get the pids controller here: `R/cells` lists it in its
 * `cgroup.subtree_control`, as cgroupfs reads it back. Then each cell's
 * `pids.max` is the kernel's; otherwise the watch alone counts processes.
 */
export function pidsDelegated(at: CgroupHost): boolean {
  return at.ok && words(read(join(at.root, "cells", "cgroup.subtree_control"))).includes("pids");
}

/**
 * A cgroup of its own for one cell, capped at `memoryMiB` (`undefined`: no
 * cap, for a crew run); `undefined` where the host has none. `share` is its
 * `cpu.weight`, `io.weight` and `cpu.max` where those controllers reach it;
 * unset leaves the defaults, 100 and no quota. `processes` is its
 * `pids.max` where the pids controller reaches it (`pidsDelegated`); unset
 * or not a positive integer, no kernel cap.
 */
export function openCellCgroup(
  memoryMiB: number | undefined,
  at: CgroupHost = cgroupHost(),
  share?: CpuShare,
  processes?: number,
): CellCgroup | undefined {
  if (!at.ok) return undefined;
  const dir = join(at.root, "cells", `c${nextCell++}-${process.pid}`);
  const maxBytes = memoryMiB === undefined ? Infinity : Math.floor(memoryMiB * 1024 * 1024);
  try {
    mkdirSync(dir);
    if (memoryMiB !== undefined) writeFileSync(join(dir, "memory.max"), String(maxBytes));
  } catch {
    removeDir(dir, 1);
    return undefined;
  }
  // Swap would only let a cell outlive its cap slowly; one OOM kills the cell, not a process of it.
  if (memoryMiB !== undefined)
    for (const [file, value] of [["memory.swap.max", "0"], ["memory.oom.group", "1"]] as const) {
      try {
        if (existsSync(join(dir, file))) writeFileSync(join(dir, file), value);
      } catch {
        // an older kernel: the cap still holds
      }
    }
  let cpuCapped = false;
  // cgroupfs makes no file it does not have: a controller not delegated is a write refused.
  if (share !== undefined) {
    const files: [string, string][] = [
      ["cpu.weight", String(share.weight)],
      ["io.weight", `default ${share.weight}`],
    ];
    if (share.cpus !== undefined && Number.isFinite(share.cpus) && share.cpus > 0)
      files.push(["cpu.max", cpuMax(share.cpus)]);
    for (const [file, value] of files) {
      try {
        writeFileSync(join(dir, file), value);
        if (file === "cpu.max") cpuCapped = true;
      } catch {
        // no cpu or io controller here: nice and SCHED_BATCH still hold
      }
    }
  }
  if (processes !== undefined && Number.isInteger(processes) && processes > 0 && pidsDelegated(at)) {
    try {
      writeFileSync(join(dir, "pids.max"), String(processes));
    } catch {
      // no pids controller here: the watch still counts the cell's processes
    }
  }
  return {
    dir,
    maxBytes,
    oomKills: () => oomKills(read(join(dir, "memory.events"))),
    cpuCapped,
    remove: () => removeDir(dir),
  };
}

/** `oom_kill` from a `memory.events` file; 0 when it is absent. */
export function oomKills(events: string | undefined): number {
  const match = /^oom_kill (\d+)$/m.exec(events ?? "");
  return match ? Number(match[1]) : 0;
}

/**
 * The argv that moves itself into the cgroup whose `cgroup.procs` is
 * `procs`, then becomes `argv` — so the cell and every process it starts
 * are under the cap from their first instruction. If it cannot enter, it
 * refuses to run rather than run uncapped. No caller text reaches the
 * shell: the path and the argv are arguments, never script.
 */
export function enterArgv(procs: string, argv: readonly string[]): string[] {
  return [
    "/bin/sh",
    "-c",
    'echo $$ > "$1" || { echo "cell: cannot enter its memory cgroup" >&2; exit 125; }; shift; exec "$@"',
    "cgroup-enter",
    procs,
    ...argv,
  ];
}

/**
 * Like `enterArgv`, for work that runs either way (a crew run): it enters
 * the cgroup if it can, and runs as before if it cannot. Arguments only.
 */
export function tryEnterArgv(procs: string, argv: readonly string[]): string[] {
  return ["/bin/sh", "-c", '{ echo $$ > "$1"; } 2>/dev/null; shift; exec "$@"', "cgroup-enter", procs, ...argv];
}
