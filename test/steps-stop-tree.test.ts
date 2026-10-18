/**
 * A step (install, test, a check) that runs as a plain child (no cell: the
 * host cannot hold one) leads its own process group, so what it started
 * ends with it: a cancel or a timeout kills the whole group, and once the
 * step's shell has exited, whatever is left of the group is killed too.
 * Before this, a cancel killed the shell alone and its children lived on,
 * re-parented, still writing into the checkout after the step had failed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep } from "../src/apps/process.ts";

/** Alive and not a zombie a parent has yet to reap. */
function alive(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  // The state follows the command name, which is in parentheses.
  const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
  return state !== "Z" && state !== "X";
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

/** The pid the step wrote once it has started its child. */
async function childPid(dir: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
      if (pid > 0) return pid;
    } catch {
      // not written yet
    }
    await Bun.sleep(25);
  }
  throw new Error("the step never started its child");
}

async function withDir(
  body: (dir: string, pids: number[]) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forge-step-tree-"));
  const pids: number[] = [];
  try {
    await body(dir, pids);
  } finally {
    // A red run must not leave its sleeper behind on the machine.
    for (const pid of pids)
      if (alive(pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone after all
        }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Starts a sleeper, writes its pid, and waits on it: the shell stays. */
const waiting = "sleep 300 >/dev/null 2>&1 & echo $! > child.pid; wait";

describe.skipIf(process.platform !== "linux")(
  "apps: an uncelled step's process tree ends with it",
  () => {
    test("a cancel ends the children the step started, not just its shell", async () => {
      await withDir(async (dir, pids) => {
        const abort = new AbortController();
        const ran = runStep("test", waiting, {
          cwd: dir,
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          log: () => {},
          signal: abort.signal,
        });
        const child = await childPid(dir);
        pids.push(child);
        abort.abort();
        const result = await ran;
        expect(result.ok ? "" : result.error).toBe("test cancelled");
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);

    test("a timeout ends the children the step started, not just its shell", async () => {
      await withDir(async (dir, pids) => {
        const ran = runStep("install", waiting, {
          cwd: dir,
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          log: () => {},
          signal: new AbortController().signal,
          timeoutMs: 1_000,
        });
        const child = await childPid(dir);
        pids.push(child);
        const result = await ran;
        expect(result.ok ? "" : result.error).toBe("install took longer than 1s");
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);

    test("a step that exits leaves no child of its own running", async () => {
      await withDir(async (dir, pids) => {
        const result = await runStep(
          "install",
          "sleep 300 >/dev/null 2>&1 & echo $! > child.pid",
          {
            cwd: dir,
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
            log: () => {},
            signal: new AbortController().signal,
          },
        );
        const child = await childPid(dir);
        pids.push(child);
        expect(result.ok).toBe(true);
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);
  },
);
