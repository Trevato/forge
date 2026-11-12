/** The API's list of pulls carries author, check word and preview address. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Bun's 5 s default is a load measurement on a busy check machine (password hashing, git, fetches); the verdict is not. */
const SLOW = 60_000;

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let cookie = "";
let repoId = "";

const addPull = (title: string, head: string) => {
  const made = createIssue(app.db, { repoId, authorId: userId, title, kind: "pull" });
  if (!made.ok) throw new Error(made.error);
  app.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', ?)")
    .run(made.value.id, `h-${head}`, head);
  return made.value;
};
// Ids rise with each call: the list reads the greatest id per pull as the latest run.
let runSeq = 0;
const run = (issueId: string, oid: string, state: string) =>
  app.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'check', ?, ?, ?)")
    .run(`zzzz-${String(++runSeq).padStart(6, "0")}`, repoId, issueId, oid, state);
let userId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-pulls-check-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  // Never started: no reconcile, no event handler, no sweeper, so nothing but this test sets or drops
  // an environment, whatever the load of the machine. The API finds the runtime by its app.
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  userId = u.value.id;
  cookie = `forge_session=${createSession(app.db, userId).token}`;
  const made = await newApp(app, u.value, { name: "notes", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.repo.id;
}, 120_000);

afterAll(async () => {
  await runtime.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const listed = async (headers: Record<string, string> = {}, state = "open") => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/pulls?state=${state}`, { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Record<string, unknown>[] };
  return Object.fromEntries(body.items.map((i) => [i["title"] as string, i])) as Record<string, Record<string, unknown>>;
};

/** An environment the runtime holds for a pull, as a sleeping preview does. */
const serveEnv = (number: number, oid: string) =>
  (runtime as unknown as { envs: Map<string, unknown> }).envs.set(`${record().id}/pull-${number}`, {
    app: record(),
    env: `pull-${number}`,
    chain: Promise.resolve(),
    restarts: [],
    asleep: { commitOid: oid, runId: "r", since: new Date().toISOString() },
  });
const record = () => getAppByRepo(app.db, repoId)!;
const pulls: Record<string, { id: string; number: number }> = {};

test("each pull names its author and its check word", async () => {
  for (const [title, head] of [["green", "g1"], ["red", "r1"], ["going", "n1"], ["stale", "s1"], ["deployed", "d1"]] as const)
    pulls[title] = addPull(title, head);
  run(pulls["green"]!.id, "g1", "ok");
  run(pulls["red"]!.id, "r1", "failed");
  run(pulls["going"]!.id, "n1", "running");
  run(pulls["stale"]!.id, "older", "ok");
  // The newest run is a deploy: the SSH pulls screen and the app door read it, so this does.
  // (ids sort last, so the runtime's own deploys of these made-up heads never outrank them)
  run(pulls["deployed"]!.id, "d1", "ok");
  app.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?, ?, 'deploy', ?, 'd1', 'failed')")
    .run(`zzzzz-${crypto.randomUUID()}`, repoId, pulls["deployed"]!.id);
  const by = await listed({ cookie });
  expect(by["green"]!["check"]).toBe("green");
  expect(by["red"]!["check"]).toBe("red");
  expect(by["going"]!["check"]).toBe("running");
  expect(by["stale"]!["check"]).toBe("none");
  expect(by["deployed"]!["check"]).toBe("red");
  expect(by["green"]!["author"]).toBe("alice");
}, SLOW);

test("a preview address only where an environment exists, and only for those who may enter the app", async () => {
  serveEnv(pulls["green"]!.number, "g1");
  const address = runtime.urlFor(record(), `pull-${pulls["green"]!.number}`);

  // A public app: every reader gets the address for the pull that has an environment, null for the rest.
  const open = await listed();
  expect(open["green"]!["preview"]).toBe(address);
  for (const item of Object.values(open)) if (item["title"] !== "green") expect(item["preview"]).toBeNull();

  // A private app on a public repository: a guest and a plain reader get none; the writer does.
  app.db.query("UPDATE app SET access = 'private' WHERE repo_id = ?1").run(repoId);
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  const bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  for (const headers of [{}, { cookie: bobCookie }]) {
    const seen = await listed(headers);
    expect(Object.values(seen).map((i) => i["preview"])).toEqual(Object.values(seen).map(() => null));
    expect(seen["green"]!["check"]).toBe("green");
  }
  expect((await listed({ cookie }))["green"]!["preview"]).toBe(address);
}, SLOW);

test("a closed pull has no preview address", async () => {
  const done = addPull("done", "c1");
  serveEnv(done.number, "c1");
  app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(done.id);
  const by = await listed({ cookie }, "closed");
  expect(by["done"]!["preview"]).toBeNull();
}, SLOW);

test("the list carries an ETag: a repeat is 304 until a pull's verdict changes", async () => {
  const url = `${servers.url}/api/v1/repos/alice/notes/pulls?state=open`;
  const first = await fetch(url, { headers: { cookie } });
  expect(first.status).toBe(200);
  const tag = first.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(first.headers.get("cache-control")).toBe("private, no-cache");
  expect(first.headers.get("vary")).toStartWith("authorization, cookie");
  await first.text();
  const again = await fetch(url, { headers: { cookie, "if-none-match": tag } });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(await again.text()).toBe("");
  run(pulls["going"]!.id, "n1", "ok");
  const changed = await fetch(url, { headers: { cookie, "if-none-match": tag } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(tag);
  await changed.text();
}, SLOW);
