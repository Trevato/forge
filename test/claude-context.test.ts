/**
 * What a session's own usage record says about its context (#8822): the last
 * assistant message's input is the context held, the result's `modelUsage`
 * names the model's window.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude, windowOf } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

const dir = await mkdtemp(join(tmpdir(), "forge-context-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a recorded usage stream gives the cost, the context held and the model's window", async () => {
  const binary = join(dir, "recorded-claude");
  writeFileSync(
    binary,
    `#!/bin/sh
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"one"}],"usage":{"input_tokens":10,"cache_read_input_tokens":90000,"output_tokens":5}}}'
echo '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"two"}],"usage":{"input_tokens":20,"cache_creation_input_tokens":10000,"cache_read_input_tokens":160000,"output_tokens":9}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"two","total_cost_usd":0.1234,"num_turns":2,"usage":{"input_tokens":30,"cache_read_input_tokens":250000,"output_tokens":14},"modelUsage":{"fake":{"contextWindow":1000000}}}'
`,
  );
  chmodSync(binary, 0o755);
  const spent: number[] = [];
  const outcome = await runClaude({
    binary, cwd: dir, prompt: "hi", appendSystemPrompt: "", budgetUsd: 1, env: {}, timeoutMs: 20_000,
    sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }), log: () => {}, signal: new AbortController().signal, settleMs: 1_000,
    onUsage: (u) => spent.push(u.tokensIn),
  });
  expect(outcome.contextTokens).toBe(170_020);
  expect(outcome.contextWindow).toBe(1_000_000);
  expect(outcome.costUsd).toBe(0.1234);
  // The running totals still sum every message.
  expect(spent[1]).toBe(90_010 + 170_020);
});

test("windowOf takes the largest window named and ignores anything else", () => {
  expect(windowOf({ a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } })).toBe(1_000_000);
  expect(windowOf({ a: { contextWindow: "big" } })).toBe(0);
  expect(windowOf(undefined)).toBe(0);
});
