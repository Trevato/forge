/** `/asks` names session, top, asks and render in Server-Timing (#3764). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssueById } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-asks-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const alice = made.value;
  await createAgent(app, alice, { username: "bot" });
  const r = await createRepo(app, alice, { name: "work", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const repo = r.value;
  await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# w\n" }] });
  addToCrew(app, alice, repo, "bot");
  await commitToBranch(app, alice, repo, {
    branch: "bot/1",
    base: "main",
    message: "Work",
    files: [{ path: "F.md", content: "1\n" }],
  });
  const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
    title: "Work",
    body: "",
    baseBranch: "main",
    headBranch: "bot/1",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const run = createRun(app.db, {
    repoId: repo.id,
    kind: "check",
    issueId: opened.value.id,
    env: `pull-${opened.value.number}`,
    commitOid: opened.value.headOid,
    reason: "pull",
  });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "ok", summary: "ok" });
  assignIssue(app, alice, repo, getIssueById(app.db, opened.value.id)!, alice);
  servers = await serve(app);
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const names = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);

test("GET /asks names its phases for someone with an ask", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/asks`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("Work");
  expect(names(res)).toEqual(expect.arrayContaining(["app", "session", "top", "asks", "render"]));
});

test("signed out, /asks still redirects and names session", async () => {
  const res = await fetch(`${servers.url}/asks`, { redirect: "manual" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain("/signin");
  expect(names(res)).toContain("session");
});
