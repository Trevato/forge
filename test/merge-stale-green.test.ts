import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { createRun, setRunBase } from "../src/core/runs.ts";
import { seedAdmin } from "./helpers/admin.ts";

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
