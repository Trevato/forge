/**
 * An app's terminal (`ssh <slug>@forge`, or `t` in the forge's terminal
 * UI) that runs as a plain child (no cell: the host cannot hold one) leads
 * its own process group, so what it started ends with it: a hangup reaches
 * the whole group, and once the program has gone, whatever is left of the
 * group is killed. Before this, a hangup signalled the program's pid alone
 * and anything it had started lived on, re-parented into the forge's own
 * process group, holding the environment's data and secrets after the
 * terminal had closed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTerminal, type TerminalProgram } from "../src/apps/tty.ts";

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

/** The pid the terminal wrote once it has started its child. */
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
  throw new Error("the terminal never started its child");
}

/** `command` on a pty with no cell, as `runAppTty` starts it where cells cannot work. */
async function withTerminal(
  command: string,
  body: (
    program: TerminalProgram,
    terminal: Bun.Terminal,
    child: number,
  ) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "forge-tty-tree-"));
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data: () => {} });
  let child: number | undefined;
  try {
    const program = startTerminal(command, {
      terminal,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      cwd: dir,
      cell: undefined,
    });
    child = await childPid(dir);
    expect(alive(child)).toBe(true);
    await body(program, terminal, child);
  } finally {
    terminal.close();
    // A red run must not leave its sleeper behind on the machine.
    if (child !== undefined && alive(child))
      try {
        process.kill(child, "SIGKILL");
      } catch {
        // gone after all
      }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Starts `sleeper` in the background, writes its pid, then reads a line and exits. */
const tty = (sleeper: string): string =>
  `exec /bin/sh -c '${sleeper} >/dev/null 2>&1 & echo $! > child.pid; read line; exit 0'`;

describe.skipIf(process.platform !== "linux")(
  "apps: an uncelled terminal's process tree ends with it",
  () => {
    test("a hangup ends the children the terminal started, not just its program", async () => {
      await withTerminal(tty("sleep 300"), async (program, _terminal, child) => {
        program.hangup();
        await program.exited;
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);

    test("a child that ignores the hangup is killed once the program has gone", async () => {
      await withTerminal(
        tty(`(trap "" HUP; exec sleep 300)`),
        async (program, _terminal, child) => {
          program.hangup();
          await program.exited;
          expect(await goneWithin(child, 3_000)).toBe(true);
        },
      );
    }, 30_000);

    test("a program that exits on its own leaves no child of its own running", async () => {
      await withTerminal(tty("sleep 300"), async (program, terminal, child) => {
        terminal.write("done\n");
        expect(await program.exited).toBe(0);
        expect(await goneWithin(child, 3_000)).toBe(true);
      });
    }, 30_000);
  },
);
