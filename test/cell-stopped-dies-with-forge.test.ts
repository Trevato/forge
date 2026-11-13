/**
 * A stopped cell dies with a killed forge (#11936). Cores are held by
 * SIGSTOP/SIGCONT; a forge killed while a tree is stopped relies on bwrap's
 * `--die-with-parent`: SIGKILL ends a stopped process, so the tree goes.
 *
 * A parent process (test/helpers/cell-parent.ts) opens a real cell; this
 * file stops the cell's tree, kills the parent, and counts what is left. The
 * tree is told apart by a sleep length only this run uses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CellSpec } from "../src/apps/contain.ts";
import { freePort, runStep } from "../src/apps/process.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";

const noCells =
  process.env["FORGE_CELLS"] === "off" ||
  process.platform !== "linux" ||
  portInsteadOfSocket() ||
  missing("bwrap", "socat");

/** Live (not zombie) processes whose command line carries `mark`, with their state. */
function tree(mark: string, except = 0): { pid: number; state: string }[] {
  const out: { pid: number; state: string }[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2)[0]!;
      if (state === "Z" || state === "X") continue;
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
      if (Number(name) !== except && cmd.includes(mark)) out.push({ pid: Number(name), state });
    } catch {
      // gone mid-read
    }
  }
  return out;
}

async function until(done: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`never came: ${what}`);
    await Bun.sleep(50); // real-timer: polling /proc for a real process tree
  }
}

describe.skipIf(noCells)("cells: a stopped tree dies with its killed parent", () => {
  let dir: string;
  // Ephemeral binds: a port the machine just gave, not one guessed.
  const port = freePort();
  const length = 600_000 + Math.floor(Math.random() * 99_999);
  let parentPid = 0;
  const mark = `sleep ${length}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-stopped-"));
  });
  afterAll(async () => {
    for (const { pid } of tree(mark, parentPid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    await rm(dir, { recursive: true, force: true });
  });

  test("SIGSTOP the tree, SIGKILL the parent: nothing survives, nothing stays in T", async () => {
    const parent = Bun.spawn(
      ["bun", join(import.meta.dir, "helpers", "cell-parent.ts"), dir, String(port), `${mark} & ${mark} & wait`],
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    parentPid = parent.pid;
    try {
      await until(() => tree(mark, parentPid).length >= 3, 15_000, "the cell's tree");
      const before = tree(mark, parentPid);
      // bwrap, the shell, and two sleeps.
      expect(before.length).toBeGreaterThanOrEqual(3);
      for (const { pid } of before) process.kill(pid, "SIGSTOP");
      // Every process stopped, and none gone: an empty tree is not "stopped".
      const stopped = (): boolean => {
        const now = tree(mark, parentPid);
        return now.length >= before.length && now.every((p) => p.state === "T");
      };
      await until(stopped, 5_000, "the tree stopped");
      expect(stopped()).toBe(true);

      parent.kill("SIGKILL");
      await parent.exited;
      await until(() => tree(mark, parentPid).length === 0, 10_000, "the tree gone");
      expect(tree(mark, parentPid)).toEqual([]);
    } finally {
      parent.kill("SIGKILL");
    }
  }, 40_000);

  const step = (command: string, lines: string[], listen: number) =>
    runStep("fresh", command, {
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      log: (l) => lines.push(l),
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      cell: {
        dir,
        writable: [],
        home: join(dir, "home"),
        hide: [],
        egress: [],
        reach: [],
        limits: { memoryMiB: 256, cpus: 1, diskMiB: 64 },
        listen,
      } satisfies CellSpec,
    });

  test("a fresh cell after that starts unpaused: its shell is not in T", async () => {
    const lines: string[] = [];
    // The shell reads its own stat (`$$`), not a child's.
    const result = await step("sleep 0.2; read -r _ _ s _ < /proc/$$/stat; echo state=$s", lines, freePort());
    expect(result.ok).toBe(true);
    const state = lines.join("\n").match(/state=(\w)/)?.[1];
    expect(state).toBeDefined();
    expect(state).not.toBe("T");
  }, 30_000);

  test("a cell stopped and continued runs on to the end", async () => {
    const run = `sleep 4.${length}`;
    const lines: string[] = [];
    const done = step(`${run}; echo finished`, lines, freePort());
    await until(() => tree(run).length >= 2, 15_000, "the second cell's tree");
    const held = tree(run);
    for (const { pid } of held) process.kill(pid, "SIGSTOP");
    const stopped = (): boolean => {
      const now = tree(run);
      return now.length >= held.length && now.every((p) => p.state === "T");
    };
    await until(stopped, 5_000, "the second tree stopped");
    for (const { pid } of held) process.kill(pid, "SIGCONT");
    const result = await done;
    expect(result.ok).toBe(true);
    expect(lines.some((l) => l.includes("finished"))).toBe(true);
  }, 40_000);
});
