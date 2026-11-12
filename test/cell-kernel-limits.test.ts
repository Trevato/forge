/**
 * #10850: what the kernel holds a cell to, tried. A cell's first shell runs
 * `RLIMIT_LINE` with `cellRlimits`; here the same line runs under the same
 * `/bin/sh` and then tries to break each limit: a file past the disk, a
 * file descriptor past the open-file limit, and raising a limit back.
 * No bubblewrap is needed for that (rlimits are the kernel's per process),
 * so these run in every sandbox; the cell's argv itself is the check's.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellCgroup, cellHostname, cellRlimits, hostnameArgs, FILES_MAX, PROCESSES_MAX, RLIMIT_LINE, TASKS_MAX } from "../src/apps/contain.ts";
import { cellLimits, cellSpecFor } from "../src/spawn/cell.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { missing } from "./helpers/tools.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cell-rlimits-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** `script` run by `/bin/sh` after the cell's own limit line, with these figures. */
async function underLimits(figures: { fileBlocks: number; files: number; tasks: number }, script: string) {
  const proc = Bun.spawn(
    ["/bin/sh", "-c", `${RLIMIT_LINE}\n${script}`, "cell", String(figures.fileBlocks), String(figures.files), String(figures.tasks)],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out: out.trim(), code };
}

describe("a cell's rlimits, figured from its size", () => {
  test("a small child's file cap is its 2048 MiB in 512-byte blocks: 2048 × 2048 = 4194304", () => {
    expect(SIZES.small.diskMiB).toBe(2048);
    expect(cellRlimits(cellLimits("small"))).toEqual({ fileBlocks: 4_194_304, files: FILES_MAX, tasks: TASKS_MAX });
    // large: 40960 MiB × 2048 = 83886080 blocks = 40 GiB, never the 50G of the report.
    expect(cellRlimits(cellLimits("large")).fileBlocks).toBe(83_886_080);
  });

  test("an unbounded disk is no file cap, never a zero one", () => {
    expect(cellRlimits({ diskMiB: Infinity }).fileBlocks).toBe(Number.MAX_SAFE_INTEGER);
    expect(cellRlimits({ diskMiB: 0 }).fileBlocks).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe.skipIf(missing("/usr/bin/fallocate"))("the kernel refuses what passes them", () => {
  // 2048 blocks of 512 bytes: a 1 MiB cell.
  const oneMiB = { fileBlocks: 2048, files: 64, tasks: TASKS_MAX };

  test("fallocate past the cell's disk fails, and nothing was allocated", async () => {
    const r = await underLimits(oneMiB, "fallocate -l 50G big; echo $?");
    // SIGXFSZ: 128 + 25.
    expect(Number(r.out)).not.toBe(0);
    expect(statSync(join(dir, "big")).size).toBe(0);
    expect(statSync(join(dir, "big")).blocks).toBe(0);
  });

  test("dd past the cell's disk stops at the cap", async () => {
    const r = await underLimits(oneMiB, "dd if=/dev/zero of=dd.out bs=1M count=5 2>/dev/null; echo $?");
    expect(Number(r.out)).not.toBe(0);
    expect(statSync(join(dir, "dd.out")).size).toBeLessThanOrEqual(1024 * 1024);
  });

  test("a file under the cap is written whole", async () => {
    const r = await underLimits(oneMiB, "dd if=/dev/zero of=ok.out bs=1k count=512 2>/dev/null; echo $?");
    expect(r.out).toBe("0");
    expect(statSync(join(dir, "ok.out")).size).toBe(512 * 1024);
  });

  test("open files past the limit are refused (EMFILE)", async () => {
    const script = `exec ${JSON.stringify(process.execPath)} -e 'const fs=require("fs");let n=0;try{for(;n<200;n++)fs.openSync("/dev/null","r")}catch(e){console.log(e.code)}'`;
    const r = await underLimits(oneMiB, script);
    expect(r.out).toBe("EMFILE");
  });

  test("nothing inside raises a limit back: soft and hard were both set", async () => {
    const r = await underLimits(oneMiB, "ulimit -f unlimited 2>/dev/null; ulimit -f; ulimit -n 100000 2>/dev/null; ulimit -n");
    expect(r.out.split("\n")).toEqual(["2048", "64"]);
  });

  test("the task limit is set", async () => {
    const r = await underLimits({ ...oneMiB, tasks: 300 }, "ulimit -u 2>/dev/null || ulimit -p");
    expect(r.out).toBe("300");
  });
});

describe("a cell's hostname is its own", () => {
  test("a child's cell is named for the child, never the parent's pod", () => {
    const spec = cellSpecFor({
      dir: join(dir, "kid"),
      parentDataDir: dir,
      parentHome: join(dir, "home"),
      parentUrl: "https://f.test",
      size: "small",
      port: 4000,
      label: "forge:kid",
      name: "kid",
    });
    expect(spec.hostname).toBe("kid");
    expect(cellHostname(spec.hostname)).toBe("kid");
  });

  test("a name becomes a DNS label, and nothing becomes 'cell'", () => {
    expect(cellHostname("Scottish Bob's forge")).toBe("scottish-bob-s-forge");
    expect(cellHostname("x".repeat(80))).toHaveLength(63);
    expect(cellHostname("--")).toBe("cell");
    expect(cellHostname(undefined)).toBe("cell");
    expect(cellHostname("a;$(reboot)")).toBe("a-reboot");
  });

  test("a host that refuses sethostname gets no --hostname, so the cell still starts", () => {
    // The check machine's bwrap answers `--hostname` with EPERM; passing it
    // anyway kept every child cell from coming up.
    expect(hostnameArgs("kid", true)).toEqual(["--hostname", "kid"]);
    expect(hostnameArgs("kid", false)).toEqual([]);
  });
});

describe("a small child's cgroup, as written", () => {
  // A stand-in for the delegated cgroup: cgroupfs files are plain files to write.
  test("memory.max 2 GiB, pids.max, and cpu.max one core whatever the host's count", () => {
    const root = join(dir, "cg");
    mkdirSync(join(root, "cells"), { recursive: true });
    writeFileSync(join(root, "cells", "cgroup.subtree_control"), "memory pids cpu io");
    const spec = cellSpecFor({
      dir: join(dir, "kid2"),
      parentDataDir: dir,
      parentHome: join(dir, "home"),
      parentUrl: "https://f.test",
      size: "small",
      port: 4001,
      label: "forge:kid2",
    });
    const made = cellCgroup(spec, { ok: true, root });
    expect(made).toBeDefined();
    const at = (file: string) => readFileSync(join(made!.dir, file), "utf8");
    // 2048 MiB × 1048576 = 2147483648 bytes.
    expect(at("memory.max")).toBe("2147483648");
    expect(at("pids.max")).toBe(String(PROCESSES_MAX));
    // One core is 100000 µs of every 100000 µs period: an absolute quota, so 64 cores on the host change nothing.
    expect(at("cpu.max")).toBe("100000 100000");
    expect(at("io.weight")).toBe("default 100");
    expect(made!.cpuCapped).toBe(true);
  });
});
