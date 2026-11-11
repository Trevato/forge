import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { createRun, setRunBase } from "../src/core/runs.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { mergePull } from "../src/actions/pulls.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { mergeable } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";

const gitEnv = gitClientEnv();

let dataDir: string;
let work: string;
let app: App;
let servers: Servers;
let base: string;
let dir: string;
const auth = { authorization: "" };

async function gitOk(args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}
const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api/v1/repos/dev/app${path}`, {
    ...init,
    headers: { ...auth, "content-type": "application/json" },
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-msg-"));
  work = await mkdtemp(join(tmpdir(), "forge-msg-work-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  await seedAdmin(app, {
    username: "dev",
    email: "dev@f.dev",
    password: "merge-stale-pass",
  });
  const token = await fetch(`${base}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adminConfirm: true,
      username: "dev",
      password: "merge-stale-pass",
      name: "cli",
      scope: "rw",
    }),
  })
    .then((r) => r.json())
    .then((j) => (j as { token: string }).token);
  auth.authorization = `Bearer ${token}`;
  await fetch(`${base}/api/v1/repos`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "app", visibility: "public" }),
  });
  dir = work;
  await gitOk([
    "clone",
    `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`,
    "app",
  ]);
  dir = join(work, "app");
  await Bun.write(join(dir, "a.txt"), "a\n");
  await gitOk(["add", "."]);
  await gitOk(["commit", "-m", "base"]);
  await gitOk(["push", "origin", "main"]);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

test("the API merge refuses a green checked against an older base when checks are required", async () => {
  await gitOk(["checkout", "-b", "feat"]);
  await Bun.write(join(dir, "b.txt"), "b\n");
  await gitOk(["add", "."]);
  await gitOk(["commit", "-m", "feat"]);
  await gitOk(["push", "origin", "feat"]);
  const made = await call("/pulls", {
    method: "POST",
    body: JSON.stringify({ base: "main", head: "feat", title: "Feat" }),
  });
  expect(made.status).toBe(201);
  app.db.query("UPDATE repo SET require_checks = 1").run();

  const oldBase = await gitOk(["rev-parse", "main"]);
  const row = app.db
    .query<{ issue_id: string; repo_id: string; head_oid: string }, []>(
      "SELECT pull.issue_id, issue.repo_id, pull.head_oid FROM pull JOIN issue ON issue.id = pull.issue_id LIMIT 1",
    )
    .get()!;
  const run = createRun(app.db, {
    repoId: row.repo_id,
    kind: "check",
    issueId: row.issue_id,
    env: "pull-1",
    commitOid: row.head_oid,
  });
  app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(run.id);
  setRunBase(app.db, run.id, oldBase);

  // The base moves on after the green.
  await gitOk(["checkout", "main"]);
  await Bun.write(join(dir, "c.txt"), "c\n");
  await gitOk(["add", "."]);
  await gitOk(["commit", "-m", "main moves"]);
  await gitOk(["push", "origin", "main"]);

  const refused = await call("/pulls/1/merge", { method: "POST", body: "{}" });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as any).error).toBe("checks_required");

  // A green against the current tip lands.
  setRunBase(app.db, run.id, await gitOk(["rev-parse", "main"]));
  const landed = await call("/pulls/1/merge", { method: "POST", body: "{}" });
  expect(landed.status).toBe(200);
});

/** A pull from `branch` off main, green against main as it is now. */
async function greenPull(branch: string): Promise<{ number: number; runId: string }> {
  await gitOk(["checkout", "main"]);
  await gitOk(["pull", "origin", "main"]);
  await gitOk(["checkout", "-b", branch]);
  await Bun.write(join(dir, `${branch}.txt`), `${branch}\n`);
  await gitOk(["add", "."]);
  await gitOk(["commit", "-m", branch]);
  await gitOk(["push", "origin", branch]);
  const made = await call("/pulls", {
    method: "POST",
    body: JSON.stringify({ base: "main", head: branch, title: branch }),
  });
  expect(made.status).toBe(201);
  const number = ((await made.json()) as { number: number }).number;
  const row = app.db
    .query<{ issue_id: string; repo_id: string; head_oid: string }, [number]>(
      "SELECT pull.issue_id, issue.repo_id, pull.head_oid FROM pull JOIN issue ON issue.id = pull.issue_id WHERE issue.number = ?1",
    )
    .get(number)!;
  const run = createRun(app.db, {
    repoId: row.repo_id,
    kind: "check",
    issueId: row.issue_id,
    env: `pull-${number}`,
    commitOid: row.head_oid,
  });
  app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(run.id);
  setRunBase(app.db, run.id, await gitOk(["rev-parse", "origin/main"]));
  return { number, runId: run.id };
}

/** Main moves on with a commit of its own. */
async function moveMain(path: string): Promise<string> {
  await gitOk(["checkout", "main"]);
  await gitOk(["pull", "origin", "main"]);
  await Bun.write(join(dir, path), "moved\n");
  await gitOk(["add", "."]);
  await gitOk(["commit", "-m", `main moves: ${path}`]);
  await gitOk(["push", "origin", "main"]);
  return gitOk(["rev-parse", "main"]);
}

let mcpId = 1;
async function mcpMerge(number: number): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: mcpId++,
      method: "tools/call",
      params: { name: "merge", arguments: { repo: "dev/app", number, dryRun: false } },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

const merged = (number: number) =>
  app.db
    .query<{ merged_at: string | null }, [number]>(
      "SELECT pull.merged_at FROM pull JOIN issue ON issue.id = pull.issue_id WHERE issue.number = ?1",
    )
    .get(number)!.merged_at;

test("the MCP merge tool refuses a green checked against an older base, and lands a fresh one", async () => {
  const pull = await greenPull("by-mcp");
  const tip = await moveMain("before-mcp.txt");

  const refused = await mcpMerge(pull.number);
  expect(refused.error).toStartWith("checks_required");
  expect(merged(pull.number)).toBeNull();
  expect(await gitOk(["ls-remote", "origin", "refs/heads/main"])).toStartWith(tip);

  setRunBase(app.db, pull.runId, tip);
  const landed = await mcpMerge(pull.number);
  expect(landed.error).toBeUndefined();
  expect(merged(pull.number)).not.toBeNull();
});

test("the merge queue's gated landing (expect) is not held by a green on an older base", async () => {
  const pull = await greenPull("by-queue");
  const tip = await moveMain("before-queue.txt");
  const repo = getRepo(app.db, "dev", "app")!;
  const p = getPull(app.db, repo.id, pull.number)!;
  const bare = repoDir(app.reposRoot, "dev", "app");
  const tree = await mergeable(bare, tip, p.headOid);
  if (!tree.ok) throw new Error(JSON.stringify(tree.error));
  const dev = getUserByName(app.db, "dev")!;

  // The same pull, without the queue's guard, is still refused.
  const held = await mergePull(app, dev, repo, p, "merge");
  expect(held.ok).toBe(false);
  if (!held.ok) expect(held.error).toBe("checks_required");

  const landed = await mergePull(app, dev, repo, p, "merge", {
    baseOid: tip,
    treeOid: tree.value.treeOid,
  });
  expect(landed.ok).toBe(true);
});
