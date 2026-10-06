/**
 * A finished session frees its slot. Once the final result is in and
 * nothing is pending, the forge closes the session's input and the run
 * settles within seconds — even when the process, or something it left
 * running, does not go on its own. A session that owes a turn and goes
 * silent is closed by the idle guard.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

const dir = await mkdtemp(join(tmpdir(), "forge-settle-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const RESULT =
  '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.01,"num_turns":1}';

/** A stand-in Claude Code: answers the prompt, then does `after`. */
function fake(name: string, after: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
sleep 0.3
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'
echo '${RESULT}'
${after}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function common(binary: string, lines: string[]) {
  return {
    binary,
    cwd: dir,
    prompt: "Do the thing.",
    appendSystemPrompt: "",
    budgetUsd: 1,
    env: {},
    sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
    // The 45-minute cap, in miniature: far past what a settle may take.
    timeoutMs: 60_000,
    log: (line: string) => lines.push(line),
    signal: new AbortController().signal,
    settleMs: 1_000,
  };
}

describe("a session after its final result", () => {
  test("one that ignores its closed input is stopped, and the run settles on its result in < 10 s", async () => {
    const lines: string[] = [];
    const started = performance.now();
    const outcome = await runClaude(
      common(fake("deaf", "sleep 600"), lines),
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("done");
    expect(outcome.reason).toBe("completed");
    expect(lines.some((l) => l.includes("after its result; stopping it"))).toBe(
      true,
    );
  }, 20_000);

  test("one that exits but leaves a child holding its output still settles in < 10 s", async () => {
    const lines: string[] = [];
    const started = performance.now();
    const outcome = await runClaude(
      common(fake("leaver", "sleep 600 &\nexit 0"), lines),
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("done");
  }, 20_000);

  test("one that ends on its own is not held for the grace", async () => {
    const lines: string[] = [];
    const started = performance.now();
    const outcome = await runClaude({
      ...common(fake("polite", "exit 0"), lines),
      settleMs: 30_000,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(outcome.ok).toBe(true);
    expect(lines.some((l) => l.startsWith("session:"))).toBe(false);
  }, 20_000);

  test("a steer folded into the turn it interrupted leaves a turn owed; the idle guard closes it", async () => {
    const lines: string[] = [];
    let send: ((text: string) => boolean) | undefined;
    const started = performance.now();
    // Reads the steer but never answers it: one result, then silence.
    const run = runClaude({
      ...common(fake("folds", "IFS= read -r second\nsleep 600"), lines),
      idleMs: 1_500,
      onSteer: (s) => {
        send = s;
      },
    });
    await Bun.sleep(100);
    expect(send!("also add a test")).toBe(true);
    const outcome = await run;
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_500);
    expect(took).toBeLessThan(10_000);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("done");
    expect(
      lines.some((l) => l.includes("no output for 2s after its last result")),
    ).toBe(true);
    // The session is closed: a later word is not heard by it, and the
    // caller makes it a comment for the next run.
    expect(send!("too late")).toBe(false);
  }, 20_000);

  test("output after the result puts the idle guard back", async () => {
    const lines: string[] = [];
    let send: ((text: string) => boolean) | undefined;
    // Answers the steer slowly, talking all the way: never idle for 1 s.
    const run = runClaude({
      ...common(
        fake(
          "slow",
          `IFS= read -r second
for i in 1 2 3 4; do sleep 0.5; echo '{"type":"assistant","message":{"content":[{"type":"text","text":"still going"}]}}'; done
echo '{"type":"result","subtype":"success","is_error":false,"result":"second","total_cost_usd":0.02,"num_turns":2}'`,
        ),
        lines,
      ),
      idleMs: 1_000,
      onSteer: (s) => {
        send = s;
      },
    });
    await Bun.sleep(100);
    expect(send!("and then this")).toBe(true);
    const outcome = await run;
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("second");
    expect(outcome.turns).toBe(2);
    expect(lines.some((l) => l.startsWith("session: no output"))).toBe(false);
  }, 20_000);
});
