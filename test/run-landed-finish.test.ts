import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { landedSummary, settleLandedRuns } from "../src/crew/interrupted.ts";
import { executeAgentRun } from "../src/crew/runner.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a run that ends after its pull landed (#12049)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-landed-finish-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const r = await createRepo(app, alice, { name: "land", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "hi\n" }] });
    const made = await createAgent(app, alice, { username: "bot", model: "", brief: "" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
    addToCrew(app, alice, repo, "bot");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A queued run, its pull merged after it began when `landed`. */
  const setup = (landed: boolean) => {
    const issue = openIssue(app, alice, repo, { title: "Plant", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    const run = createRun(app.db, {
      repoId: repo.id, kind: "agent", issueId: issue.value.id, actorId: bot.id, reason: "assigned",
    });
    const branch = `scout/${n++}`;
    app.db.query("UPDATE run SET branch = ?2 WHERE id = ?1").run(run.id, branch);
    let number = 0;
    let pullIssueId = "";
    let headBranch = branch;
    if (landed) {
      const pull = openIssue(app, alice, repo, { title: "The pull", body: "" });
      if (!pull.ok) throw new Error(String(pull.error));
      number = pull.value.number;
      pullIssueId = pull.value.id;
      app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(pull.value.id);
      app.db
        .query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at)
           VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
        )
        .run(pull.value.id, headBranch, repo.id, new Date(Date.now() + 60_000).toISOString());
    }
    return { run, number, pullIssueId, headBranch };
  };

  /** Run it against a stand-in `claude` that says `text` and exits 1. */
  const finish = async (run: { id: string }, text: string) => {
    const bin = join(dataDir, `claude-${n++}`);
    await writeFile(bin, `#!/bin/sh\necho '${text}' >&2\necho '${text}'\nexit 1\n`);
    await chmod(bin, 0o755);
    await executeAgentRun(app, getRun(app.db, run.id)!, {
      forgeUrl: servers.url, localUrl: servers.url, binary: bin,
      concurrency: 1, budgetUsd: 1, runTimeoutMs: 20_000,
    });
    return getRun(app.db, run.id)!;
  };

  const mcpRuns = async (): Promise<any[]> => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "runs", arguments: { repo: `alice/${repo.name}`, kind: "agent" } },
      }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text).runs;
  };
  let token = "";

  test("a run a restart cut short after its pull landed ends ok, Landed, in the runs list", async () => {
    token = createToken(app.db, alice.id, "rw", "rw").token;
    const { run, number } = setup(true);
    const after = await finish(run, "restart: the forge stopped");
    expect(after.state).toBe("ok");
    expect(after.summary).toBe(landedSummary(number));
    expect(after.summary).toMatch(/^Landed: pull #\d+ is live$/);
    expect((await mcpRuns()).find((r) => r.id === run.id)?.state).toBe("ok");
  }, 40_000);

  test("a real failure keeps its words even when the pull landed", async () => {
    const { run } = setup(true);
    const after = await finish(run, "API Error: 500 broke");
    expect(after.state).toBe("failed");
    expect(after.summary).toContain("API Error: 500 broke");
    expect(after.summary).not.toMatch(/^Landed/);
  }, 40_000);

  test("the same cut-short run with no landed pull still reads interrupted", async () => {
    const { run } = setup(false);
    const after = await finish(run, "restart: the forge stopped");
    expect(after.state).toBe("failed");
    expect(after.summary).toMatch(/^interrupted: /);
  }, 40_000);

  test("a run still in flight reads as done the moment its pull lands", () => {
    const { run, number, pullIssueId, headBranch } = setup(false);
    app.db.query("UPDATE run SET state = 'running', started_at = ?2 WHERE id = ?1").run(run.id, new Date().toISOString());
    const ids = settleLandedRuns(app.db, { issueId: pullIssueId, headBranch, number: 7, repoId: repo.id });
    expect(ids).toEqual([run.id]);
    expect(getRun(app.db, run.id)!.state).toBe("ok");
    expect(getRun(app.db, run.id)!.summary).toBe(landedSummary(7));
    expect(number).toBe(0);
  });
});
