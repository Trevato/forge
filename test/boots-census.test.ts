/**
 * What the forge counts about itself after a crash (#3708): how often it
 * has started and how many starts followed one that never exited cleanly
 * (`kernel/boots.ts`); what runs beside it, by name (`kernel/census.ts`);
 * and which `socat`s are Claude Code bridges a session left behind
 * (`crew/leftovers.ts`) — and nothing else on the machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootCounts, KEPT, recordBoot, recordCleanExit } from "../src/kernel/boots.ts";
import { census, censusWords, parseStat, processRows, type ProcessRow } from "../src/kernel/census.ts";
import { leftoverBridgeGroups, reapLeftoverBridges } from "../src/crew/leftovers.ts";

const root = await mkdtemp(join(tmpdir(), "forge-boots-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const dir = join(root, String(n++));
  mkdirSync(dir);
  return dir;
};

describe("boots: starts and crashes, counted across processes", () => {
  test("a first start is no restart", () => {
    const dir = fresh();
    expect(recordBoot(dir, "a")).toEqual({ boots: 1, restarts: 0, unclean: 0 });
  });

  test("a start after a clean exit is a restart, not a crash", () => {
    const dir = fresh();
    recordBoot(dir, "a");
    recordCleanExit(dir, "a");
    expect(recordBoot(dir, "b")).toEqual({ boots: 2, restarts: 1, unclean: 0 });
  });

  test("a start after a process that never said goodbye counts the crash", () => {
    const dir = fresh();
    recordBoot(dir, "a"); // segfault: no clean exit
    expect(recordBoot(dir, "b")).toEqual({ boots: 2, restarts: 1, unclean: 1 });
    recordBoot(dir, "c"); // and again
    expect(bootCounts(dir, "c")).toEqual({ boots: 3, restarts: 2, unclean: 2 });
  });

  test("a release's old process draining beside the new one settles back once it exits", () => {
    const dir = fresh();
    recordBoot(dir, "old");
    expect(recordBoot(dir, "new").unclean).toBe(1);
    recordCleanExit(dir, "old");
    expect(bootCounts(dir, "new")).toEqual({ boots: 2, restarts: 1, unclean: 0 });
  });

  test("the total keeps counting past the starts it remembers one by one", () => {
    const dir = fresh();
    for (let i = 0; i < KEPT + 10; i++) recordBoot(dir, `s${i}`);
    const counts = bootCounts(dir, `s${KEPT + 9}`);
    expect(counts.boots).toBe(KEPT + 10);
    expect(counts.unclean).toBe(KEPT - 1);
    const kept = JSON.parse(readFileSync(join(dir, "boots.json"), "utf8")) as { starts: unknown[] };
    expect(kept.starts.length).toBe(KEPT);
  });

  test("a corrupt ledger starts over instead of failing the boot", () => {
    const dir = fresh();
    writeFileSync(join(dir, "boots.json"), "{not json");
    expect(recordBoot(dir, "a")).toEqual({ boots: 1, restarts: 0, unclean: 0 });
    writeFileSync(join(dir, "boots.json"), JSON.stringify({ total: "x", starts: [{ id: 1 }] }));
    expect(recordBoot(dir, "b")).toEqual({ boots: 1, restarts: 0, unclean: 0 });
  });

  test("a data directory that cannot be written still boots", () => {
    expect(recordBoot(join(root, "no", "such", "dir"), "a").boots).toBe(1);
  });
});

describe("census: the process table by name", () => {
  test("a stat line is read past a name with spaces and parentheses", () => {
    expect(parseStat("4242 (my (odd) name) S 1 4240 4240 0 -1")).toEqual({
      pid: 4242,
      ppid: 1,
      pgid: 4240,
      comm: "my (odd) name",
    });
    expect(parseStat("garbage")).toBeUndefined();
  });

  test("counts by name, most first, without this process", () => {
    const rows: ProcessRow[] = [
      { pid: 10, ppid: 1, pgid: 10, comm: "socat" },
      { pid: 11, ppid: 1, pgid: 11, comm: "socat" },
      { pid: 12, ppid: 1, pgid: 12, comm: "socat" },
      { pid: 13, ppid: 1, pgid: 13, comm: "bwrap" },
      { pid: 14, ppid: 1, pgid: 14, comm: "bun" },
      { pid: 99, ppid: 1, pgid: 99, comm: "bun" },
    ];
    const counts = census(rows, 99);
    expect(counts.get("socat")).toBe(3);
    expect(counts.get("bun")).toBe(1);
    expect(censusWords(counts)).toBe("socat=3 bun=1 bwrap=1");
    expect(censusWords(counts, 1)).toBe("socat=3");
    expect(censusWords(new Map([["a b=c", 2]]))).toBe("a_b_c=2");
  });

  test("a table read from a directory, skipping what is not a process", () => {
    const proc = fresh();
    for (const [pid, stat] of [
      ["7", "7 (socat) S 1 7 7"],
      ["8", "8 (bun) S 1 8 8"],
    ] as const) {
      mkdirSync(join(proc, pid));
      writeFileSync(join(proc, pid, "stat"), stat);
    }
    mkdirSync(join(proc, "self"));
    mkdirSync(join(proc, "9")); // gone mid-read: no stat
    expect(processRows(proc).map((r) => r.comm).sort()).toEqual(["bun", "socat"]);
    expect(processRows(join(proc, "missing"))).toEqual([]);
  });

  test.skipIf(process.platform !== "linux")("the real table holds this process", () => {
    expect(processRows().some((r) => r.pid === process.pid)).toBe(true);
  });
});

describe("leftovers: Claude Code bridges a session left behind", () => {
  const crew = "/data/crew";
  const rows: ProcessRow[] = [
    { pid: 50, ppid: 1, pgid: 50, comm: "bun" }, // the forge
    // An orphaned bridge and the fork it made for a connection.
    { pid: 60, ppid: 1, pgid: 58, comm: "socat" },
    { pid: 61, ppid: 60, pgid: 58, comm: "socat" },
    // A live session's bridge: its parent is still there.
    { pid: 70, ppid: 69, pgid: 69, comm: "socat" },
    // A person's own socat, orphaned, naming nothing of the crew's.
    { pid: 80, ppid: 1, pgid: 80, comm: "socat" },
    // An orphan that names the crew's directory but is not socat.
    { pid: 90, ppid: 1, pgid: 90, comm: "sleep" },
    // A socat in the forge's own group, never killed by group.
    { pid: 95, ppid: 1, pgid: 50, comm: "socat" },
  ];
  const cmd: Record<number, string> = {
    60: "socat UNIX-LISTEN:/data/crew/torque/.t/abc/claude-http.sock,fork,reuseaddr TCP:localhost:3128",
    61: "socat UNIX-LISTEN:/data/crew/torque/.t/abc/claude-http.sock,fork,reuseaddr TCP:localhost:3128",
    70: "socat UNIX-LISTEN:/data/crew/torque/.t/def/claude-http.sock,fork TCP:localhost:3129",
    80: "socat TCP-LISTEN:8080,fork TCP:example.com:80",
    90: "sleep 300 /data/crew/x",
    95: "socat UNIX-LISTEN:/data/crew/torque/.t/ghi/claude-socks.sock,fork TCP:localhost:1080",
  };
  const cmdline = (pid: number): string => cmd[pid] ?? "";

  test("only an orphaned socat naming the crew's directory, by its group", () => {
    expect(leftoverBridgeGroups(rows, crew, cmdline, 50)).toEqual([58]);
    // A directory that merely starts the same is not the crew's.
    expect(leftoverBridgeGroups(rows, "/data/cr", cmdline, 50)).toEqual([]);
  });

  test("each group is killed once, and one gone meanwhile is not counted", () => {
    const killed: number[] = [];
    expect(reapLeftoverBridges(rows, crew, (g) => killed.push(g), cmdline, 50)).toBe(1);
    expect(killed).toEqual([58]);
    const gone = reapLeftoverBridges(rows, crew, () => {
      throw new Error("ESRCH");
    }, cmdline, 50);
    expect(gone).toBe(0);
  });
});
