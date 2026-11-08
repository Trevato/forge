/**
 * An admin re-checks, in one call, every open pull whose latest check failed
 * on one named test (#6445).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { recheckNamed, RECHECK_MAX } from "../src/checks/recheck.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let repo: Repo;
let cookie = "";
let bobCookie = "";
const pulls: Pull[] = [];

const asked = () => listRuns(app.db, repo.id, { kind: "check" }).filter((r) => r.reason === "asked");

function redOn(pull: Pull, name: string): void {
  const run = createRun(app.db, { repoId: repo.id, kind: "check", env: `pull-${pull.number}`, commitOid: pull.headOid, issueId: pull.id });
  claimRun(app.db, run.id);
  finishRun(app.db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 1, failed: 1, names: [name] } });
}

const call = (body: unknown, headers: Record<string, string> = {}, who = cookie) =>
  fetch(`${servers.url}/api/v1/repos/alice/engine/checks/recheck`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: who, ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-recheck-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  const alice = getUserByName(app.db, "alice")!;
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  const made = await createRepo(app, alice, { name: "engine", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "a.ts", content: "1\n" }] });
  for (const n of [1, 2, 3]) {
    await commitToBranch(app, alice, repo, { branch: `f/${n}`, base: "main", message: `F${n}`, files: [{ path: `f${n}.ts`, content: `${n}\n` }] });
    const opened = await openPull(app, alice, repo, { title: `F${n}`, body: "", baseBranch: "main", headBranch: `f/${n}` });
    if (!opened.ok) throw new Error(String(opened.error));
    pulls.push(opened.value);
  }
  const request: ChecksHandle["request"] = async (r, env, oid, reason, issueId) =>
    createRun(app.db, { repoId: r.id, kind: "check", env, commitOid: oid, reason, issueId });
  provideChecksForTest(app, { request } as unknown as ChecksHandle);
  redOn(pulls[0]!, "tools/list stays in budget");
  redOn(pulls[1]!, "tools/list stays in budget");
  redOn(pulls[2]!, "something else");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a non-admin gets 404 and queues nothing", async () => {
  expect((await call({ test: "tools/list stays in budget" }, {}, bobCookie)).status).toBe(404);
  expect(asked()).toHaveLength(0);
});

test("a foreign Origin is refused", async () => {
  expect((await call({ test: "tools/list stays in budget" }, { origin: "https://evil.example" })).status).toBe(403);
  expect(asked()).toHaveLength(0);
});

test("an empty or overlong test name is a 400", async () => {
  expect((await call({ test: "" })).status).toBe(400);
  expect((await call({})).status).toBe(400);
  expect((await call({ test: "x".repeat(301) })).status).toBe(400);
  expect(asked()).toHaveLength(0);
});

test("the pulls red on the named test are queued, the one red on another is not", async () => {
  const res = await call({ test: "tools/list stays in budget" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ queued: [pulls[0]!.number, pulls[1]!.number] });
  expect(asked().map((r) => r.issueId).sort()).toEqual([pulls[0]!.id, pulls[1]!.id].sort());
});

test("a pull whose latest check is no longer red is not queued again", async () => {
  const res = await call({ test: "tools/list stays in budget" });
  expect(((await res.json()) as { queued: number[] }).queued).toEqual([]);
});

test("past the cap, the rest are left and the answer says how many", async () => {
  const alice = getUserByName(app.db, "alice")!;
  expect(RECHECK_MAX).toBe(50);
  redOn(pulls[0]!, "capped");
  redOn(pulls[1]!, "capped");
  const done = await recheckNamed(app, alice, repo, "capped", 1);
  expect(done).toEqual({ queued: [pulls[0]!.number], left: 1 });
  const next = await recheckNamed(app, alice, repo, "capped", 1);
  expect(next).toEqual({ queued: [pulls[1]!.number], left: 0 });
});
