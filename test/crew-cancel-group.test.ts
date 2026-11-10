/**
 * A cancelled crew run leaves no process behind (#10698). `runClaude`
 * starts the agent `detached`, in a group of its own, and a cancel signals
 * that whole group (`signalGroup`), so a tool call the agent forked — and
 * whatever that forked in turn — ends with it, not five seconds later when
 * the reader gives up, and not never.
 *
 * The stand-in agent forks a background shell that holds its stdout open
 * (as a tool call left running does) and that shell forks a long `sleep`.
 * Signalling the agent alone would leave both alive past the 2 s bound:
 * the open pipe keeps the run waiting until its 5 s read deadline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

const dir = await mkdtemp(join(tmpdir(), "forge-cancel-group-"));
const started: number[] = [];
afterAll(async () => {
  for (const pid of started)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone, as it should be
    }
  await rm(dir, { recursive: true, force: true });
});

/** Alive and not a zombie waiting for its new parent to reap it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** Polls, never a fixed sleep: true once every pid is gone, false at the deadline. */
async function allGoneWithin(pids: readonly number[], ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !alive(pid))) return true;
    await Bun.sleep(20);
  }
  return pids.every((pid) => !alive(pid));
}

async function waitFor(file: string, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) return pid;
    }
    await Bun.sleep(20);
  }
  throw new Error(`${file} never named a pid`);
}

describe.skipIf(process.platform !== "linux")("a cancelled crew run", () => {
  test("takes the agent's forked child and that child's own child with it within 2 s", async () => {
    const binary = join(dir, "agent");
    const childFile = join(dir, "child.pid");
    const grandFile = join(dir, "grand.pid");
    const agentFile = join(dir, "agent.pid");
    // The child keeps stdout open and waits on its own sleeping child; the
    // grandchild's pid is written last, so both exist once it is there.
    writeFileSync(
      binary,
      `#!/bin/sh
IFS= read -r first
echo $$ > ${agentFile}
sh -c 'sleep 300 & echo $$ > ${childFile}; echo $! > ${grandFile}.tmp; mv ${grandFile}.tmp ${grandFile}; wait' &
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
sleep 300
`,
    );
    chmodSync(binary, 0o755);

    const abort = new AbortController();
    const run = runClaude({
      binary,
      cwd: dir,
      prompt: "Do the thing.",
      appendSystemPrompt: "",
      budgetUsd: 1,
      env: {},
      sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
      timeoutMs: 60_000,
      log: () => {},
      signal: abort.signal,
      settleMs: 1_000,
    });

    const grand = await waitFor(grandFile, 10_000);
    const child = await waitFor(childFile, 1_000);
    const agent = await waitFor(agentFile, 1_000);
    const pids = [agent, child, grand];
    started.push(...pids);
    expect(pids.every(alive)).toBe(true);

    abort.abort();
    expect(await allGoneWithin(pids, 2_000)).toBe(true);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("cancelled");
    // Reaped too, not left as zombies: no pid answers signal 0.
    const deadline = Date.now() + 2_000;
    const answers = (): number[] =>
      pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    while (answers().length > 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(answers()).toEqual([]);
  }, 20_000);
});
