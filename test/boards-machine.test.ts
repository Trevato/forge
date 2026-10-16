/**
 * readMachine(root): fake cgroup and /proc files under a temp dir give the
 * expected point; what is missing is null; nothing readable gives a reason.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMachine } from "../src/boards/machine.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "machine-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

describe("readMachine", () => {
  test("turns cgroup and /proc files into one point", () => {
    put("sys/fs/cgroup/cpu.stat", "usage_usec 123456\nuser_usec 100\n");
    put("sys/fs/cgroup/memory.current", "5242880\n");
    put("proc/meminfo", "MemTotal:       1000 kB\nMemFree: 10 kB\nMemAvailable:    400 kB\n");
    put("proc/loadavg", "0.52 0.40 0.30 1/200 999\n");
    expect(readMachine(root)).toEqual({
      ok: true,
      point: { cpuUsec: 123456, memoryBytes: 5242880, nodeMemoryBytes: 600 * 1024, load: 0.52 },
    });
  });

  test("the cgroup alone is enough; the /proc fields are null", () => {
    put("sys/fs/cgroup/cpu.stat", "usage_usec 7\n");
    put("sys/fs/cgroup/memory.current", "42\n");
    expect(readMachine(root)).toEqual({
      ok: true,
      point: { cpuUsec: 7, memoryBytes: 42, nodeMemoryBytes: null, load: null },
    });
  });

  test("a garbled file is null, not a throw", () => {
    put("sys/fs/cgroup/memory.current", "max\n");
    put("proc/loadavg", "1.5 1 1 1/1 1\n");
    const m = readMachine(root);
    expect(m.ok && m.point).toEqual({ cpuUsec: null, memoryBytes: null, nodeMemoryBytes: null, load: 1.5 });
  });

  test("a missing directory gives the reason", () => {
    const m = readMachine(join(root, "nope"));
    expect(m.ok).toBe(false);
    expect(!m.ok && m.reason).toContain("readable");
  });

  test("a root with nothing in it gives the reason", () => {
    expect(readMachine(root).ok).toBe(false);
  });
});
