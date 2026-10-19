/** A crew run's process tree shows as crew:<name> while it runs, and only then. */
import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WATCH, cellCounters } from "../src/apps/contain.ts";
import { runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

test("a run is listed as crew:<name> in cellCounters while it runs, not after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-watch-"));
  const fake = join(dir, "fake-claude");
  writeFileSync(
    fake,
    `#!/bin/sh
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
sleep 1.5
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
`,
  );
  chmodSync(fake, 0o755);
  const listed = () => cellCounters().some((c) => c.label === "crew:bot");
  const run = runClaude({
    binary: fake,
    cwd: dir,
    prompt: "go",
    appendSystemPrompt: "",
    budgetUsd: 1,
    env: {},
    sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
    timeoutMs: 10_000,
    log: () => {},
    signal: new AbortController().signal,
    label: "crew:bot",
  });
  await Bun.sleep(WATCH.tickMs + 300);
  expect(listed()).toBe(true);
  await run;
  expect(listed()).toBe(false);
  await rm(dir, { recursive: true, force: true });
}, 20_000);
