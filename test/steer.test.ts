/**
 * Steering: a person says something while the agent runs, and the agent
 * hears it as its next turn. The session stays open only while something
 * is pending; a turn nobody followed ends it.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/crew/claude.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

describe("steering a running agent", () => {
  test("a message sent mid-turn becomes the next turn; without one the session ends after the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-steer-"));
    // The stand-in: answers the first message after a moment, then, if a
    // second arrives before stdin closes, answers that too.
    const fake = join(dir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
sleep 0.4
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"first turn done"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
if IFS= read -r second; then
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"heard: '"$(printf '%s' "$second" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/')"'"}]}}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok again","total_cost_usd":0.02,"num_turns":2}'
fi
`,
    );
    chmodSync(fake, 0o755);
    const lines: string[] = [];
    const common = {
      binary: fake,
      cwd: dir,
      appendSystemPrompt: "",
      budgetUsd: 1,
      env: {},
      sandbox: sandboxPolicy({ dataDir: dir, agentName: "bot", urls: [] }),
      timeoutMs: 10_000,
      log: (line: string) => lines.push(line),
      signal: new AbortController().signal,
    };

    // Steered while the first turn runs: two turns, the second hears us.
    let send: ((text: string) => boolean) | undefined;
    const steered = runClaude({
      ...common,
      prompt: "Do the thing.",
      onSteer: (s) => {
        send = s;
      },
    });
    await Bun.sleep(150);
    expect(send).toBeDefined();
    expect(send!("also add a test")).toBe(true);
    const outcome = await steered;
    expect(outcome.ok).toBe(true);
    expect(outcome.turns).toBe(2);
    expect(lines).toContain("heard: also add a test");
    // Once the session ended, there is nobody to hear.
    expect(send!("too late")).toBe(false);

    // Not steered: one turn, and the session ends on its own.
    lines.length = 0;
    const quiet = await runClaude({ ...common, prompt: "Do the thing." });
    expect(quiet.ok).toBe(true);
    expect(quiet.turns).toBe(1);
    expect(lines.some((l) => l.startsWith("heard:"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("a comment while the agent works", () => {
  test("reaches it as its next turn; no second run queues behind the first", async () => {
    const { createApp } = await import("../src/app.ts");
    const { serve } = await import("../src/http/server.ts");
    const { startCrew } = await import("../src/crew/dispatch.ts");
    const { createUser } = await import("../src/core/users.ts");
    const { addToCrew, createAgent } = await import("../src/actions/crew.ts");
    const { commitToBranch, createRepo } =
      await import("../src/actions/repos.ts");
    const { addComment, assignIssue, openIssue } =
      await import("../src/actions/issues.ts");
    const { listRuns } = await import("../src/core/runs.ts");
    const { readFileSync } = await import("node:fs");

    const dataDir = await mkdtemp(join(tmpdir(), "forge-steer-crew-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s2","model":"fake"}'
sleep 2.5
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"first turn done"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
if IFS= read -r second; then
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"heard: '"$(printf '%s' "$second" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/')"'"}]}}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok again","total_cost_usd":0.02,"num_turns":2}'
fi
`,
    );
    chmodSync(fake, 0o755);
    const crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    try {
      const a = await createUser(app.db, {
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      const alice = a.value;
      const made = await createAgent(app, alice, {
        username: "bot",
        brief: "Be brief.",
      });
      if (!made.ok) throw new Error(String(made.error));
      const created = await createRepo(app, alice, {
        name: "garden",
        visibility: "private",
      });
      if (!created.ok) throw new Error(String(created.error));
      const repo = created.value;
      const seeded = await commitToBranch(app, alice, repo, {
        message: "Start",
        files: [{ path: "README.md", content: "# garden\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);

      const issue = openIssue(app, alice, repo, {
        title: "Plant tulips",
        body: "Along the fence.",
      });
      if (!issue.ok) throw new Error(String(issue.error));
      expect(
        assignIssue(app, alice, repo, issue.value, made.value.user).ok,
      ).toBe(true);
      // Wait for the run to be under way, then speak.
      const running = async () => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const run = listRuns(app.db, repo.id, { kind: "agent" }).find(
            (r) => r.state === "running",
          );
          if (run) return run;
          await Bun.sleep(50);
        }
        throw new Error("the run never started");
      };
      const run = await running();
      await Bun.sleep(300); // past the session's first line
      expect(
        addComment(app, alice, repo, issue.value, "also the tests").ok,
      ).toBe(true);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const r = listRuns(app.db, repo.id, { kind: "agent" }).find(
          (x) => x.id === run.id,
        );
        if (r && r.state !== "running") break;
        await Bun.sleep(100);
      }
      const runs = listRuns(app.db, repo.id, { kind: "agent" });
      expect(runs.length).toBe(1);
      expect(runs[0]!.state).toBe("ok");
      expect(runs[0]!.turns).toBe(2);
      const log = readFileSync(join(dataDir, "runs", `${run.id}.log`), "utf8");
      expect(log).toContain("you: alice on #1: also the tests");
      expect(log).toContain("heard: alice on #1: also the tests");
    } finally {
      await crew.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
