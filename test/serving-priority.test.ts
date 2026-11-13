/**
 * The forge's own web process always answers (#3319): its event loop's
 * lateness is measured as a p99 a board can chart, and the work it starts
 * — check steps, crew runs, installs and the browser — runs in the
 * background class (nice 10, SCHED_BATCH, best-effort IO level 7), so a full
 * lane slows checks, not pages. The load test burns 12 cells' worth of CPU beside a server and
 * holds its /healthz p99 under 200 ms.
 */

import { describe, expect, test } from "bun:test";
import { backgroundArgv, BACKGROUND_NICE, CREW_CPUS, crewCpus } from "../src/apps/background.ts";
import { nearestRank, startLoopLag } from "../src/kernel/loop_lag.ts";
import { runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";
import { childEnv, runStep } from "../src/apps/process.ts";
import { tmpdir } from "node:os";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fields of `/proc/<pid>/stat` after the command name: index 0 is field 3 (state), so field n is n − 3. */
const statFields = (text: string): string[] => text.slice(text.lastIndexOf(")") + 2).trim().split(" ");
const NICE = 19 - 3;
const POLICY = 41 - 3;
const SCHED_BATCH = 3;

describe("nearest-rank percentile", () => {
  test("rank ⌈p/100 · n⌉ of the sorted list, hand-counted", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i); // 100 … 1
    expect(nearestRank(hundred, 99)).toBe(99); // rank 99
    expect(nearestRank(hundred, 50)).toBe(50);
    expect(nearestRank([3, 1, 2], 99)).toBe(3); // ⌈2.97⌉ = 3
    expect(nearestRank([5], 99)).toBe(5);
    expect(nearestRank([], 99)).toBeNull();
  });
});

describe("event-loop lag", () => {
  test("a loop blocked for 120 ms shows it in the window's p99; the next window starts empty", async () => {
    const lag = startLoopLag(10);
    try {
      await Bun.sleep(40);
      const until = performance.now() + 120;
      while (performance.now() < until) {
        // the loop is held: no timer can fire
      }
      await Bun.sleep(30);
      expect(lag.take()!).toBeGreaterThanOrEqual(100);
      await Bun.sleep(60);
      expect(lag.take()!).toBeLessThan(100);
    } finally {
      lag.stop();
    }
  });

  test("no wake in the window is no number, never a zero", () => {
    const lag = startLoopLag(60_000);
    expect(lag.take()).toBeNull();
    lag.stop();
  });
});

describe("FORGE_CREW_CPUS", () => {
  test("a number of cores above 0 and at most 1024; anything else is the default", () => {
    expect(crewCpus("6")).toBe(6);
    expect(crewCpus("0.5")).toBe(0.5);
    for (const raw of [undefined, "", " ", "0", "-2", "1025", "four", "Infinity"]) expect(crewCpus(raw)).toBe(CREW_CPUS);
  });
});

const hasProc = await Bun.file("/proc/self/stat").exists();

describe.skipIf(!hasProc)("the background class", () => {
  test("the child and what it starts run at nice 10, SCHED_BATCH where chrt is, same argv", async () => {
    const proc = Bun.spawn(backgroundArgv(["/bin/sh", "-c", 'cat /proc/self/stat; echo "$1|$2"', "x", "a b", "$(c)"]), {
      stdout: "pipe",
    });
    const [stat, args] = (await new Response(proc.stdout).text()).trim().split("\n");
    expect(await proc.exited).toBe(0);
    const f = statFields(stat!);
    // `nice -n` adds to the niceness the runner already has (a niced check
    // runs this test), capped at 19.
    const mine = Number(statFields(await Bun.file("/proc/self/stat").text())[NICE]);
    expect(Number(f[NICE])).toBe(Math.min(19, mine + BACKGROUND_NICE));
    if (Bun.which("chrt") !== null) expect(Number(f[POLICY])).toBe(SCHED_BATCH);
    // Arguments pass as arguments: a space and a `$(…)` are never script.
    expect(args).toBe("a b|$(c)");
  });

  test("a check step started by runStep, and what its shell starts, run in the background class", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-step-"));
    const out = join(dir, "stat");
    // The step's shell starts a grandchild: the class is inherited, nothing sets it again.
    const done = await runStep("check", `sh -c 'cat /proc/self/stat > ${out}'`, {
      cwd: dir,
      env: childEnv({}),
      log: () => {},
      signal: new AbortController().signal,
    });
    expect(done.ok).toBe(true);
    const f = statFields(readFileSync(out, "utf8"));
    const mine = Number(statFields(await Bun.file("/proc/self/stat").text())[NICE]);
    expect(Number(f[NICE])).toBe(Math.min(19, mine + BACKGROUND_NICE));
    if (Bun.which("chrt") !== null) expect(Number(f[POLICY])).toBe(SCHED_BATCH);
  });

  test("a crew run started by runClaude, and what it starts, run in the background class", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-crew-"));
    const out = join(dir, "stat");
    const fake = join(dir, "claude");
    writeFileSync(fake, `#!/bin/sh\ncat /proc/self/stat > "${out}"\n`);
    chmodSync(fake, 0o755);
    await runClaude({
      binary: fake,
      cwd: dir,
      prompt: "",
      appendSystemPrompt: "",
      budgetUsd: 0,
      env: {},
      sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
      timeoutMs: 10_000,
      log: () => {},
      signal: new AbortController().signal,
    });
    const f = statFields(readFileSync(out, "utf8"));
    const mine = Number(statFields(await Bun.file("/proc/self/stat").text())[NICE]);
    expect(Number(f[NICE])).toBe(Math.min(19, mine + BACKGROUND_NICE));
    if (Bun.which("chrt") !== null) expect(Number(f[POLICY])).toBe(SCHED_BATCH);
  });

  test.skipIf(Bun.which("ionice") === null)("its IO is best-effort at level 7", async () => {
    const proc = Bun.spawn(backgroundArgv(["/bin/sh", "-c", "ionice -p $$"]), { stdout: "pipe" });
    expect((await new Response(proc.stdout).text()).trim()).toBe("best-effort: prio 7");
  });

  test("a crew run whose binary is not there fails at spawn, as it did before the background class", async () => {
    const dir = process.env.TMPDIR ?? "/tmp";
    const run = runClaude({
      binary: `${dir}/no-such-claude-${process.pid}`,
      cwd: dir,
      prompt: "",
      appendSystemPrompt: "",
      budgetUsd: 0,
      env: {},
      sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
      timeoutMs: 5_000,
      log: () => {},
      signal: new AbortController().signal,
    });
    // ENOENT is what the caller turns into a failed run; nice's exit 127 read as "no changes pushed".
    await expect(run).rejects.toThrow(/ENOENT/);
  });

  test("a command that is not there fails as itself, and its exit status comes through", async () => {
    const missing = Bun.spawn(backgroundArgv(["/no/such/binary"]), { stdout: "ignore", stderr: "ignore" });
    expect(await missing.exited).toBe(127);
    const three = Bun.spawn(backgroundArgv(["/bin/sh", "-c", "exit 3"]));
    expect(await three.exited).toBe(3);
  });
});

/**
 * A busy loop that is the spawned process itself (backgroundArgv execs
 * into it), so `kill(9)` stops it, and that ends itself once the process
 * named as its owner is gone, so none outlives a test cut off mid-run. A
 * wrapper such as timeout(1) would fork the loop as its child: killing the
 * wrapper orphans the loop, and twelve of them burned a check's 16 cores.
 */
const BURN_WHILE = 'while kill -0 "$1" 2>/dev/null; do :; done';
const burner = (owner: number) => ["/bin/sh", "-c", BURN_WHILE, "burner", String(owner)];

describe.skipIf(!hasProc)("a burner", () => {
  test("ends itself when its owner is gone", async () => {
    // The outer shell starts a burner it owns and exits at once.
    const outer = Bun.spawn(["/bin/sh", "-c", 'sh -c "$1" burner $$ >/dev/null 2>&1 & echo $!', "outer", BURN_WHILE], {
      stdout: "pipe",
    });
    const pid = Number((await new Response(outer.stdout).text()).trim());
    await outer.exited;
    expect(pid).toBeGreaterThan(0);
    const gone = async () => {
      const stat = Bun.file(`/proc/${pid}/stat`);
      if (!(await stat.exists())) return true;
      try {
        return statFields(await stat.text())[0] === "Z";
      } catch {
        return true;
      }
    };
    const until = performance.now() + 2000;
    while (!(await gone()) && performance.now() < until) await Bun.sleep(20);
    const ended = await gone();
    if (!ended) process.kill(pid, 9);
    expect(ended).toBe(true);
  });
});

/**
 * 12 cells' worth of CPU (each a busy loop, in the background class, as a
 * check step is) beside a server whose /healthz runs one `select 1`. On a
 * machine with fewer cores than burners the server competes for every
 * core, which is the case the background class is for.
 */
describe.skipIf(!hasProc)("12 CPU-burning cells beside the server", () => {
  test("/healthz p99 stays under 200 ms and no probe fails", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/healthz"
          ? (db.query("select 1").get(), new Response("ok"))
          : new Response("no", { status: 404 }),
    });
    const burners = Array.from({ length: 12 }, () =>
      Bun.spawn(backgroundArgv(burner(process.pid)), { stdout: "ignore", stderr: "ignore" }),
    );
    try {
      await Bun.sleep(300);
      const times: number[] = [];
      let failed = 0;
      for (let i = 0; i < 60; i++) {
        const start = performance.now();
        try {
          const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, { signal: AbortSignal.timeout(1000) });
          if (res.status !== 200 || (await res.text()) !== "ok") failed++;
        } catch {
          failed++;
        }
        times.push(performance.now() - start);
        await Bun.sleep(10);
      }
      expect(failed).toBe(0);
      expect(nearestRank(times, 99)!).toBeLessThan(200);
    } finally {
      for (const b of burners) b.kill(9);
      await Promise.all(burners.map((b) => b.exited));
      server.stop(true);
      db.close();
    }
  }, 30_000);
});
