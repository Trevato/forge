/**
 * A check never takes the forge down (#2410): each cell runs in a cgroup of
 * its own whose `memory.max` is the cell's memory limit, so a check that
 * allocates past it is killed by the kernel, alone, between two ticks of
 * the watch. The layout is proven on a directory shaped like cgroupfs; the
 * kernel's kill end to end where this host delegates a cgroup to the forge
 * (it skips, and says why, where it does not — a crew sandbox's is
 * read-only).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cgroupHost,
  cgroupRoot,
  cpuMax,
  enterArgv,
  oomKills,
  tryEnterArgv,
  openCellCgroup,
  prepare,
} from "../src/apps/cgroup.ts";
import { cellCgroup, cellsAvailable, processCapHolder, PROCESSES_MAX, type CellSpec } from "../src/apps/contain.ts";
import { childEnv, runStep } from "../src/apps/process.ts";
import type { Proc, Raw } from "../src/system/proc.ts";
import { buildSystem } from "../src/system/view.ts";

describe("which cgroup is the forge's to divide", () => {
  test("off, a relative or climbing path, cgroup v1 and a shared login session are refused", () => {
    expect(cgroupRoot("off").ok).toBe(false);
    expect(cgroupRoot("sys/fs/cgroup").ok).toBe(false);
    expect(cgroupRoot("/sys/fs/cgroup/../../etc").ok).toBe(false);
    expect(cgroupRoot("", () => "12:memory:/x\n11:cpu:/x\n").ok).toBe(false);
    const session = cgroupRoot("", () => "0::/user.slice/user-1000.slice/session-2.scope\n");
    expect(session.ok).toBe(false);
    if (!session.ok) expect(session.reason).toContain("FORGE_CELL_CGROUP");
  });

  test("a container's own cgroup namespace root, or the one named", () => {
    if (process.platform === "linux")
      expect(cgroupRoot("", () => "0::/\n")).toEqual({ ok: true, root: "/sys/fs/cgroup" });
    expect(cgroupRoot("/sys/fs/cgroup/forge.slice")).toEqual({ ok: true, root: "/sys/fs/cgroup/forge.slice" });
  });
});

describe("the layout, on a directory shaped like cgroupfs", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-cgroup-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const fake = (name: string, controllers: string): string => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "cgroup.controllers"), controllers);
    writeFileSync(join(dir, "cgroup.procs"), "11\n12\n");
    writeFileSync(join(dir, "cgroup.subtree_control"), "");
    return dir;
  };

  test("no memory controller: watched only, and why", () => {
    const dir = fake("nomem", "cpu io\n");
    const host = prepare({ ok: true, root: dir });
    expect(host.ok).toBe(false);
    if (!host.ok) expect(host.reason).toContain("no memory controller");
    expect(openCellCgroup(64, host)).toBeUndefined();
  });

  test.skipIf(process.getuid?.() === 0)("read-only to the forge: watched only, and why", () => {
    const dir = fake("ro", "cpu memory\n");
    for (const f of ["cgroup.procs", "cgroup.subtree_control"]) Bun.spawnSync(["chmod", "0444", join(dir, f)]);
    const host = prepare({ ok: true, root: dir });
    expect(host.ok).toBe(false);
    if (!host.ok) expect(host.reason).toContain("read-only");
  });

  test("the forge's processes move to a leaf, cells get the memory controller, and a crash's leftovers go", () => {
    // No cpu or io controller: the fake's files hold the last write, and this is about memory.
    const dir = fake("rw", "cpuset memory pids\n");
    // A forge that is gone left one; a forge still draining a roll (this process) keeps its own.
    const gone = Bun.spawnSync(["/bin/true"]).pid;
    mkdirSync(join(dir, "cells", `c7-${gone}`), { recursive: true });
    mkdirSync(join(dir, "cells", `c8-${process.pid}`), { recursive: true });
    const host = prepare({ ok: true, root: dir });
    expect(host).toEqual({ ok: true, root: dir });
    // One pid a write: the last one written is what the plain file holds.
    expect(readFileSync(join(dir, "forge", "cgroup.procs"), "utf8")).toBe("12");
    // The fake holds the last write; cgroupfs adds each: memory, then pids.
    expect(readFileSync(join(dir, "cgroup.subtree_control"), "utf8")).toBe("+pids");
    expect(readFileSync(join(dir, "cells", "cgroup.subtree_control"), "utf8")).toBe("+pids");
    expect(existsSync(join(dir, "cells", `c7-${gone}`))).toBe(false);
    expect(existsSync(join(dir, "cells", `c8-${process.pid}`))).toBe(true);
    // Already laid out (cgroupfs reads back `memory`): nothing moves again.
    writeFileSync(join(dir, "cgroup.subtree_control"), "memory\n");
    writeFileSync(join(dir, "forge", "cgroup.procs"), "");
    expect(prepare({ ok: true, root: dir }).ok).toBe(true);
    expect(readFileSync(join(dir, "forge", "cgroup.procs"), "utf8")).toBe("");
  });

  test("where cpu and io are delegated, the forge weighs 1000, a step's cell 10 and an app's the default", () => {
    const dir = fake("weights", "cpu io memory\n");
    const host = prepare({ ok: true, root: dir });
    expect(host.ok).toBe(true);
    // The fake holds the last write; cgroupfs adds each: memory, then cpu, then io.
    expect(readFileSync(join(dir, "cgroup.subtree_control"), "utf8")).toBe("+io");
    expect(readFileSync(join(dir, "cells", "cgroup.subtree_control"), "utf8")).toBe("+io");
    expect(readFileSync(join(dir, "forge", "cpu.weight"), "utf8")).toBe("1000");
    expect(readFileSync(join(dir, "forge", "io.weight"), "utf8")).toBe("default 1000");
    const step = openCellCgroup(64, host, { weight: 10, cpus: 16 })!;
    expect(readFileSync(join(step.dir, "memory.max"), "utf8")).toBe(String(64 * 1024 * 1024));
    expect(readFileSync(join(step.dir, "cpu.weight"), "utf8")).toBe("10");
    expect(readFileSync(join(step.dir, "io.weight"), "utf8")).toBe("default 10");
    // 16 cores: 16 × 100 000 µs of CPU in each 100 000 µs period.
    expect(readFileSync(join(step.dir, "cpu.max"), "utf8")).toBe("1600000 100000");
    expect(step.cpuCapped).toBe(true);
    const app = openCellCgroup(64, host)!;
    expect(existsSync(join(app.dir, "cpu.weight"))).toBe(false);
    expect(existsSync(join(app.dir, "cpu.max"))).toBe(false);
    expect(app.cpuCapped).toBe(false);
  });

  const spec = (dir: string): CellSpec => ({
    dir,
    writable: [],
    home: join(dir, ".home"),
    hide: [],
    egress: [],
    reach: [],
    limits: { memoryMiB: 64, cpus: 2, diskMiB: 512 },
  });

  test("where pids is delegated, a cell's process count is the kernel's: pids.max at the watch's limit, and /system says so", () => {
    const dir = fake("pids", "memory pids\n");
    const host = prepare({ ok: true, root: dir });
    expect(host.ok).toBe(true);
    expect(existsSync(join(dir, "forge", "pids.weight"))).toBe(false);
    // cgroupfs reads back every controller enabled, without the `+`.
    writeFileSync(join(dir, "cells", "cgroup.subtree_control"), "memory pids\n");
    expect(processCapHolder(host)).toEqual({ by: "kernel" });
    // What openCell opens: its own spec, the watch's limit as pids.max.
    const cell = cellCgroup(spec(join(dir, "app")), host)!;
    expect(readFileSync(join(cell.dir, "memory.max"), "utf8")).toBe(String(64 * 1024 * 1024));
    expect(readFileSync(join(cell.dir, "pids.max"), "utf8")).toBe(String(PROCESSES_MAX));
    expect(PROCESSES_MAX).toBe(512);
    // Not asked for (a crew run), or not a positive integer: no file.
    for (const processes of [undefined, 0, -1, 1.5, Number.NaN]) {
      const run = openCellCgroup(undefined, host, { weight: 10, cpus: 4 }, processes)!;
      expect(existsSync(join(run.dir, "pids.max"))).toBe(false);
    }
  });

  test("no pids controller: the cell still opens with its memory cap, no pids.max, and /system says the watch counts", () => {
    const dir = fake("nopids", "memory\n");
    const host = prepare({ ok: true, root: dir });
    expect(host.ok).toBe(true);
    // Memory is still what the cells are given.
    expect(readFileSync(join(dir, "cgroup.subtree_control"), "utf8")).toBe("+memory");
    expect(readFileSync(join(dir, "cells", "cgroup.subtree_control"), "utf8")).toBe("+memory");
    const cell = cellCgroup(spec(join(dir, "app")), host)!;
    expect(cell).toBeDefined();
    expect(readFileSync(join(cell.dir, "memory.max"), "utf8")).toBe(String(64 * 1024 * 1024));
    expect(existsSync(join(cell.dir, "pids.max"))).toBe(false);
    const holder = processCapHolder(host);
    expect(holder.by).toBe("watch");
    if (holder.by === "watch") expect(holder.reason).toContain("pids controller");
    // No cgroup at all: the host's own reason.
    expect(processCapHolder({ ok: false, reason: "FORGE_CELL_CGROUP=off" })).toEqual({ by: "watch", reason: "FORGE_CELL_CGROUP=off" });
  });

  test("a crew run's cell has no memory cap, weighs 10 and is held to its cores", () => {
    const dir = fake("crew", "cpu io memory\n");
    const host = prepare({ ok: true, root: dir });
    const run = openCellCgroup(undefined, host, { weight: 10, cpus: 4 })!;
    expect(run.maxBytes).toBe(Infinity);
    for (const file of ["memory.max", "memory.swap.max", "memory.oom.group"])
      expect(existsSync(join(run.dir, file))).toBe(false);
    expect(readFileSync(join(run.dir, "cpu.weight"), "utf8")).toBe("10");
    expect(readFileSync(join(run.dir, "cpu.max"), "utf8")).toBe("400000 100000");
    // Named like any cell, so a restart sweeps it once this forge is gone.
    expect(run.dir).toMatch(/\/cells\/c\d+-\d+$/);
  });

  test("cpu.max by hand: 2 cores, half a core, and the kernel's 1 ms floor", () => {
    expect(cpuMax(2)).toBe("200000 100000");
    expect(cpuMax(0.5)).toBe("50000 100000");
    expect(cpuMax(0.001)).toBe("1000 100000");
  });

  test("a cell's cgroup is capped at its limit, swapless, killed whole; its OOM kills read back", () => {
    const dir = fake("cell", "memory\n");
    const host = prepare({ ok: true, root: dir });
    const cell = openCellCgroup(8192, host);
    expect(cell).toBeDefined();
    expect(cell!.dir.startsWith(join(dir, "cells", "c"))).toBe(true);
    expect(cell!.maxBytes).toBe(8192 * 1024 * 1024);
    expect(readFileSync(join(cell!.dir, "memory.max"), "utf8")).toBe("8589934592");
    // The kernel makes these files; here, a kernel that has them.
    writeFileSync(join(cell!.dir, "memory.events"), "low 0\nhigh 0\nmax 9\noom 1\noom_kill 1\noom_group_kill 1\n");
    expect(cell!.oomKills()).toBe(1);
    expect(openCellCgroup(64, host)!.dir).not.toBe(cell!.dir);
  });

  test("oom_kill is read from memory.events, and absent is none", () => {
    expect(oomKills("oom 0\noom_kill 0\n")).toBe(0);
    expect(oomKills("oom 3\noom_kill 2\n")).toBe(2);
    expect(oomKills(undefined)).toBe(0);
    expect(oomKills("oom_kill_x 5\n")).toBe(0);
  });
});

describe("entering the cgroup before the cell starts", () => {
  test("the process writes its own pid, then becomes the command — same pid, so all it starts is inside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-cgroup-enter-"));
    try {
      const procs = join(dir, "cgroup.procs");
      writeFileSync(procs, "");
      const proc = Bun.spawn(enterArgv(procs, ["/bin/sh", "-c", "echo $$"]), { stdout: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      expect(await proc.exited).toBe(0);
      expect(out).toBe(String(proc.pid));
      expect(readFileSync(procs, "utf8").trim()).toBe(String(proc.pid));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cgroup it cannot enter: it refuses to run uncapped, and the path is never script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-cgroup-enter-"));
    try {
      const marker = join(dir, "ran");
      const procs = join(dir, "gone", `$(touch ${join(dir, "injected")})`, "cgroup.procs");
      const proc = Bun.spawn(enterArgv(procs, ["/bin/sh", "-c", `touch ${marker}`]), { stderr: "pipe" });
      const text = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(125);
      expect(text).toContain("cannot enter its memory cgroup");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, "injected"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a crew run enters its cell if it can", () => {
  test("it enters, then becomes the command; a cell it cannot enter runs it anyway, and the path is never script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-cgroup-try-"));
    try {
      const procs = join(dir, "cgroup.procs");
      writeFileSync(procs, "");
      const inside = Bun.spawn(tryEnterArgv(procs, ["/bin/sh", "-c", "echo $$"]), { stdout: "pipe" });
      expect((await new Response(inside.stdout).text()).trim()).toBe(String(inside.pid));
      expect(readFileSync(procs, "utf8").trim()).toBe(String(inside.pid));
      const gone = join(dir, "gone", `$(touch ${join(dir, "injected")})`, "cgroup.procs");
      const outside = Bun.spawn(tryEnterArgv(gone, ["/bin/sh", "-c", "exit 3"]), { stderr: "pipe" });
      expect(await outside.exited).toBe(3);
      expect(await new Response(outside.stderr).text()).toBe("");
      expect(existsSync(join(dir, "injected"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/system: a check cell's memory beside its cap", () => {
  test("a cell's group carries its cap and who holds it; the forge's carries none", () => {
    const proc = (pid: number, ppid: number, rss: number): Proc => ({ pid, ppid, comm: "bun", ticks: 0, rss, age: 5, tests: [] });
    const raw: Raw = {
      at: 1_000,
      cores: [],
      temps: [],
      load: null,
      memory: null,
      disks: [],
      net: [],
      io: [],
      procs: [proc(1, 0, 100), proc(200, 1, 1 << 20), proc(201, 200, 3 << 20)],
    };
    const v = buildSystem(undefined, raw, [
      { label: "check:RUN1", root: 200, cap: { bytes: 8192 * 2 ** 20, by: "kernel" } },
    ], 1);
    const check = v.groups.find((g) => g.label === "check:RUN1")!;
    expect(check.rssBytes).toBe(4 << 20);
    expect(check.capBytes).toBe(8589934592);
    expect(check.capBy).toBe("kernel");
    const forge = v.groups.find((g) => g.label === "forge")!;
    expect(forge.capBytes).toBeNull();
    expect(forge.capBy).toBeNull();
  });
});

// The kernel's own kill, on a host that delegates a cgroup to the forge and holds cells.
const host = cgroupHost();
const cells = await cellsAvailable();
const why = !host.ok ? host.reason : !cells.ok ? cells.reason : undefined;
if (why !== undefined) console.log(`cgroup.test.ts: the kernel's kill is skipped here: ${why}`);

describe.skipIf(why !== undefined)("a check over its memory cap fails alone; the forge stays up", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-cgroup-e2e-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cell = (name: string, memoryMiB: number): CellSpec => ({
    dir: join(dir, name),
    writable: [],
    home: join(dir, name, ".home"),
    hide: [],
    egress: [],
    reach: [],
    // CPU and disk out of the way: only memory decides.
    limits: { memoryMiB, cpus: 64, diskMiB: 4096 },
  });
  const step = (command: string, spec: CellSpec) =>
    runStep("check", command, {
      cwd: spec.dir,
      env: childEnv({}),
      log: () => {},
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      cell: spec,
    });

  test("1 GiB allocated in a burst under a 96 MiB cap: the kernel kills that check, its neighbour finishes", async () => {
    mkdirSync(join(dir, "hog"), { recursive: true });
    mkdirSync(join(dir, "calm"), { recursive: true });
    const before = process.memoryUsage().rss;
    const [hog, calm] = await Promise.all([
      // Faster than the watch's one-second tick: only the kernel can stop it in time.
      step(`bun -e "const a = []; for (let i = 0; i < 64; i++) a.push(new Uint8Array(16 << 20).fill(1)); console.log(a.length)"`, cell("hog", 96)),
      step(`bun -e "const a = new Uint8Array(16 << 20).fill(1); await Bun.sleep(1500); console.log(a[0])"`, cell("calm", 256)),
    ]);
    expect(hog.ok).toBe(false);
    if (!hog.ok)
      expect(hog.error).toBe("check stopped: it reached its 96 MiB memory cap, and the kernel killed it");
    expect(calm.ok).toBe(true);
    // The forge (this process) is alive and did not pay for the hog.
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 2 ** 20);
  }, 60_000);
});
