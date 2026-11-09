/**
 * Steering: a person says something while the agent runs, and the agent
 * hears it as its next turn. The session stays open only while something
 * is pending; a turn nobody followed ends it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { listRuns } from "../src/core/runs.ts";
import { runClaude } from "../src/crew/claude.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { serve } from "../src/http/server.ts";
import { sandboxPolicy } from "../src/crew/sandbox.ts";

/**
 * The stand-in agent: answers the first message, but holds that first turn
 * open until the test creates `gate` (no fixed wait, so no race and no
 * idle seconds); then, if a second message arrives before stdin closes, it
 * answers that too.
 */
function fakeClaude(path: string, gate: string, session: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"${session}","model":"fake"}'
while [ ! -e '${gate}' ]; do sleep 0.01; done
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"first turn done"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
if IFS= read -r second; then
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"heard: '"$(printf '%s' "$second" | sed 's/.*"text":"\\([^"]*\\)".*/\\1/')"'"}]}}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok again","total_cost_usd":0.02,"num_turns":2}'
fi
`,
  );
  chmodSync(path, 0o755);
}

/** Polls `ready` every 10 ms until it holds; throws past `ms`. */
async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`never: ${what}`);
    await Bun.sleep(10);
  }
}

describe("steering a running agent", () => {
  test("a message sent mid-turn becomes the next turn; without one the session ends after the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-steer-"));
    // Invariant: a steer sent mid-turn is heard as the next turn; without one the session ends after the first.
    const fake = join(dir, "fake-claude");
    const gate = join(dir, "gate");
    fakeClaude(fake, gate, "s1");
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
    await until(() => lines.some((l) => l.includes("s1")), "the session opened");
    expect(send).toBeDefined();
    expect(send!("also add a test")).toBe(true);
    writeFileSync(gate, "");
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
  }, 10_000);
});

describe("a comment while the agent works", () => {
  // One forge, one crew, one agent and one repository for the file.
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let servers: Awaited<ReturnType<typeof serve>>;
  let crew: Awaited<ReturnType<typeof startCrew>>;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let gate: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-steer-crew-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const fake = join(dataDir, "fake-claude");
    gate = join(dataDir, "gate");
    fakeClaude(fake, gate, "s2");
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      // The pump's clock: a short tick, so no test waits out the 5 s one.
      tickMs: 20,
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    if (!addToCrew(app, alice, repo, "bot").ok) throw new Error("bot not on the crew");
  });

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("reaches it as its next turn; no second run queues behind the first", async () => {
    // Invariant: a comment on the issue an agent is running on steers that run (two turns, one run), never queues another.
    const issue = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "Along the fence.",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(
      assignIssue(app, alice, repo, issue.value, bot).ok,
    ).toBe(true);
    // Wait for the run to be under way, then speak.
    let run: ReturnType<typeof listRuns>[number] | undefined;
    await until(() => {
      run = listRuns(app.db, repo.id, { kind: "agent" }).find(
        (r) => r.state === "running",
      );
      return run !== undefined;
    }, "the run started");
    // Past the session's first line: `running` is set before the agent
    // is spawned, so speaking too early would queue a second run. The
    // session line proves it can hear us.
    const logPath = join(dataDir, "runs", `${run!.id}.log`);
    const logged = (text: string) => async () =>
      (await Bun.file(logPath).text().catch(() => "")).includes(text);
    await until(logged("session s2"), "the session opened");
    expect(
      addComment(app, alice, repo, issue.value, "also the tests").ok,
    ).toBe(true);
    // The steer is on its way to the agent; only now may its first turn end.
    // The comment either reached the session or queued a run of its own.
    await until(
      async () =>
        (await logged("you: alice on #1")()) ||
        listRuns(app.db, repo.id, { kind: "agent" }).length > 1,
      "the comment was sent as a steer or queued",
    );
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(1);
    writeFileSync(gate, "");
    await until(
      () =>
        listRuns(app.db, repo.id, { kind: "agent" }).find((x) => x.id === run!.id)
          ?.state !== "running",
      "the run settled",
    );
    const runs = listRuns(app.db, repo.id, { kind: "agent" });
    expect(runs.length).toBe(1);
    expect(runs[0]!.state).toBe("ok");
    expect(runs[0]!.turns).toBe(2);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("you: alice on #1: also the tests");
    expect(log).toContain("heard: alice on #1: also the tests");
  }, 10_000);
});
