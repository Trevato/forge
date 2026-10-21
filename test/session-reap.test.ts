/**
 * A crew session's leftovers end with it (#3708). Claude Code starts its
 * sandbox bridges (`socat UNIX-LISTEN:…,fork`) in its own process group;
 * a session that ends without stopping them left them alive, re-parented
 * to pid 1, and 255 socats were counted in one pod. Whatever a session
 * leaves in its group is killed the moment it ends, however it ended.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapGroup, runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

const dir = await mkdtemp(join(tmpdir(), "forge-reap-"));
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

const RESULT =
  '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01,"num_turns":1}';

/** Alive and not a zombie waiting to be reaped. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(25);
  }
  return !alive(pid);
}

/**
 * A stand-in Claude Code that starts a bridge-like sleeper in its group
 * (its output let go, as Claude Code's `stdio: "ignore"` does), writes its
 * pid, then does `ending`.
 */
function fake(name: string, ending: string): { binary: string; pidFile: string } {
  const binary = join(dir, name);
  const pidFile = join(dir, `${name}.pid`);
  writeFileSync(
    binary,
    `#!/bin/sh
IFS= read -r first
sleep 300 >/dev/null 2>&1 </dev/null &
echo $! > ${pidFile}
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
${ending}
`,
  );
  chmodSync(binary, 0o755);
  return { binary, pidFile };
}

function input(binary: string) {
  return {
    binary,
    cwd: dir,
    prompt: "Do the thing.",
    appendSystemPrompt: "",
    budgetUsd: 1,
    env: {},
    sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
    timeoutMs: 60_000,
    log: () => {},
    signal: new AbortController().signal,
    settleMs: 1_000,
  };
}

const leftover = (pidFile: string): number => {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  started.push(pid);
  return pid;
};

describe.skipIf(process.platform !== "linux")("a crew session's leftovers", () => {
  test("a session that finishes cleanly takes what it left running with it", async () => {
    const { binary, pidFile } = fake("clean", `echo '${RESULT}'\nexit 0`);
    const outcome = await runClaude(input(binary));
    expect(outcome.ok).toBe(true);
    expect(await goneWithin(leftover(pidFile), 3_000)).toBe(true);
  }, 20_000);

  test("a session that dies without a result takes what it left running with it", async () => {
    const { binary, pidFile } = fake("crashed", "exit 3");
    const outcome = await runClaude(input(binary));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("exit 3");
    expect(await goneWithin(leftover(pidFile), 3_000)).toBe(true);
  }, 20_000);

  test("reapGroup never signals this process, pid 1 or a nonsense id", () => {
    // Each of these would be fatal or meaningless; none may throw either.
    for (const pgid of [0, 1, -5, Number.NaN, 1.5, process.pid]) reapGroup(pgid);
    expect(alive(process.pid)).toBe(true);
  });

  test("reapGroup on an empty group is quiet", async () => {
    const proc = Bun.spawn(["/bin/true"], { detached: true, stdout: "ignore" });
    await proc.exited;
    expect(() => reapGroup(proc.pid)).not.toThrow();
  });
});
