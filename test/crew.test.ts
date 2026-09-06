/**
 * The crew loop with a stand-in for Claude Code: a script that speaks
 * stream-json, edits a file, commits and pushes — so the whole harness is
 * exercised (dispatch off the outbox, the per-run token, the clone and
 * branch, the prompt, landing the pull, the follow-up that resumes the
 * session, the bounds) without spending a cent or needing a login.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  addComment,
  assignIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { workdirFor } from "../src/crew/runner.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { listComments } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the crew, with a stand-in Claude Code", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let argsFile: string;
  let promptFile: string;

  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "agent" }).find(where);
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(100);
    }
    throw new Error("agent run did not settle");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    argsFile = join(dataDir, "fake.args");
    promptFile = join(dataDir, "fake.prompt");
    // The stand-in: records its argv and prompt, does the work, pushes.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
cat > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
if grep -q DECLINE-ME "${promptFile}"; then
  echo "half-done edit" > SHOULD-NOT-LAND.md
  echo '{"type":"result","subtype":"success","is_error":false,"result":"DECLINED: this is out of scope for me.","total_cost_usd":0.005,"num_turns":1,"session_id":"fake-2","terminal_reason":"completed"}'
  exit 0
fi
echo "work by the crew $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "crew work" && git push -q -u origin HEAD
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Added CREW.md."},{"type":"tool_use","name":"Bash","input":{"command":"git push"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added CREW.md as asked.","total_cost_usd":0.01,"num_turns":3,"session_id":"fake-1","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const a = await createUser(app.db, {
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
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the stand-in is detected", () => {
    expect(crew.ready).toBe(true);
    expect(crew.detail).toContain("2.1.0");
  });

  let issueNumber = 0;

  test("assignment: clone, branch, brief, work, and the forge opens the pull", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Plant tulips",
      body: "Along the fence.",
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    issueNumber = issue.value.number;
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);

    const run = await settled((r) => r.reason === "assigned");
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+/);
    expect(run.sessionId).toBe("fake-1");
    expect(run.costUsd).toBeCloseTo(0.01);
    expect(run.branch).toBe("bot/1-plant-tulips");

    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--restricted");
    expect(args).toContain("--max-budget-usd\n1.00");
    expect(args).not.toContain("--resume");
    // The sandbox policy: the forge reachable, the forge's data not readable,
    // the agent's own clone not among the denials.
    const settings = JSON.parse(
      args.split("--settings\n")[1]!.split("\n")[0]!,
    ) as {
      sandbox: {
        enabled: boolean;
        network: { allowedDomains: string[] };
        filesystem: { denyRead: string[] };
      };
    };
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.network.allowedDomains).toContain("localhost");
    expect(settings.sandbox.network.allowedDomains).toContain(
      "registry.npmjs.org",
    );
    expect(settings.sandbox.filesystem.denyRead).toContain(
      join(dataDir, "repos"),
    );
    expect(settings.sandbox.filesystem.denyRead).toContain(
      join(dataDir, "secret.key"),
    );
    expect(
      settings.sandbox.filesystem.denyRead.some((p) => p.includes("/crew/bot")),
    ).toBe(false);
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Issue #1: Plant tulips");
    expect(prompt).toContain("Along the fence.");
    expect(prompt).toContain("bot/1-plant-tulips");

    const pulls = listPulls(app.db, repo.id, { state: "open" });
    expect(pulls.length).toBe(1);
    const pull = pulls[0]!;
    expect(pull.authorName).toBe("bot");
    expect(pull.headBranch).toBe("bot/1-plant-tulips");
    expect(pull.title).toBe("Plant tulips");
    expect(pull.body).toContain("Added CREW.md as asked.");
    expect(pull.body).toContain(`Closes #${issueNumber}`);
    // The run's credential is gone; the clone stays for the follow-up.
    const tokens = app.db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM token WHERE name LIKE 'run:%'")
      .get();
    expect(tokens?.n).toBe(0);
    expect(
      existsSync(
        join(
          workdirFor(
            dataDir,
            getAgentByName(app.db, "bot")!,
            repo,
            issueNumber,
          ),
          ".git",
        ),
      ),
    ).toBe(true);
  }, 60_000);

  test("feedback from a person resumes the session on the same branch", async () => {
    const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    const before = listRuns(app.db, repo.id, { kind: "agent" }).length;
    // The agent's own comment is not feedback.
    expect(addComment(app, bot, repo, pull, "Working on it.").ok).toBe(true);
    await Bun.sleep(300);
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(before);
    // A person's is.
    expect(
      addComment(app, alice, repo, pull, "Also plant daffodils please.").ok,
    ).toBe(true);
    const run = await settled((r) => r.reason === "feedback");
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^updated pull #\d+/);
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("--resume\nfake-1");
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("feedback on your pull");
    expect(prompt).toContain("Also plant daffodils please.");
    expect(prompt).not.toContain("Working on it.");
    // The agent reported on the pull, and the branch moved.
    const comments = listComments(app.db, pull.id).filter(
      (c) => c.authorName === "bot",
    );
    expect(comments.map((c) => c.body)).toContain("Added CREW.md as asked.");
    // The branch moved on the forge (the pull row keeps its opening snapshot;
    // the live head is git's).
    const tip = await resolveOid(
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      `refs/heads/${pull.headBranch}`,
    );
    expect(tip).toBeDefined();
    expect(tip).not.toBe(pull.headOid);
  }, 60_000);

  test("an agent may decline: nothing lands, the reason is posted", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Do something shady",
      body: "DECLINE-ME",
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const run = await settled((r) => r.issueId === issue.value.id);
    expect(run.state).toBe("failed");
    expect(run.summary).toBe("declined: this is out of scope for me.");
    // No pull for it, no branch pushed, and the half-done edit stayed home.
    const pulls = listPulls(app.db, repo.id, { state: "open" });
    expect(pulls.some((p) => p.title === "Do something shady")).toBe(false);
    const tip = await resolveOid(
      repoDir(app.reposRoot, repo.ownerName, repo.name),
      `refs/heads/${run.branch}`,
    );
    expect(tip).toBeUndefined();
    const comments = listComments(app.db, issue.value.id);
    expect(comments.map((c) => `${c.authorName}: ${c.body}`)).toContain(
      "bot: Declined: this is out of scope for me.",
    );
  }, 60_000);

  test("closing the pull removes the clone; a closed issue starts nothing", async () => {
    const pull = listPulls(app.db, repo.id, { state: "open" })[0]!;
    const dir = workdirFor(
      dataDir,
      getAgentByName(app.db, "bot")!,
      repo,
      issueNumber,
    );
    expect(existsSync(dir)).toBe(true);
    expect(setIssueState(app, alice, repo, pull, "closed").ok).toBe(true);
    const deadline = Date.now() + 5_000;
    while (existsSync(dir) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(dir)).toBe(false);
    const before = listRuns(app.db, repo.id, { kind: "agent" }).length;
    expect(addComment(app, alice, repo, pull, "one more thing").ok).toBe(true);
    await Bun.sleep(300);
    expect(listRuns(app.db, repo.id, { kind: "agent" }).length).toBe(before);
  }, 30_000);
});
