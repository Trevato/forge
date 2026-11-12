/**
 * What a cancel counts as ended (#10826): the leader, every live member of
 * its process group, and every live process under it — a `setsid`
 * grandchild included, a zombie or a stranger not. And the one line the
 * run's log gets.
 */
import { describe, expect, test } from "bun:test";
import { endedLine, liveTree, parseStat, treeOf, type ProcRow } from "../src/runs/ended.ts";

const row = (pid: number, ppid: number, pgrp: number, state = "S"): ProcRow => ({ pid, ppid, pgrp, state });

describe("treeOf", () => {
  test("reaches the leader, its group, and descendants that left the group", () => {
    const rows = [
      row(1, 0, 1),
      row(100, 1, 100), // the leader
      row(101, 100, 100), // its child
      row(102, 101, 100), // grandchild, same group
      row(103, 101, 103), // grandchild that called setsid
      row(104, 103, 103), // and its own child
      row(105, 1, 100), // reparented to init, still in the group
      row(106, 100, 100, "Z"), // over already
      row(200, 1, 200), // a stranger
    ];
    expect(treeOf(rows, 100)).toEqual([100, 101, 102, 103, 104, 105]);
  });

  test("is empty once the leader and its group are gone", () => {
    expect(treeOf([row(1, 0, 1), row(200, 1, 200)], 100)).toEqual([]);
  });
});

describe("parseStat", () => {
  test("reads state, parent and group past a name with spaces and parentheses", () => {
    expect(parseStat(42, "42 (a (b) c) S 7 42 42 0 -1")).toEqual({ pid: 42, ppid: 7, pgrp: 42, state: "S" });
    expect(parseStat(42, "garbage")).toBeUndefined();
  });
});

describe("endedLine", () => {
  test("is one line with the count", () => {
    expect(endedLine(1)).toBe("cancel ended 1 process");
    expect(endedLine(3)).toBe("cancel ended 3 processes");
    expect(endedLine(0)).toBe("cancel ended 0 processes");
    expect(endedLine(Number.NaN)).toBe("cancel ended 0 processes");
  });
});

describe.skipIf(process.platform !== "linux")("liveTree", () => {
  test("counts a real child and the grandchild it forked", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait"], { detached: true, stdout: "ignore" });
    try {
      const deadline = Date.now() + 5_000;
      while (liveTree(proc.pid).length < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(liveTree(proc.pid).length).toBe(2);
    } finally {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
    await proc.exited;
  });
});
