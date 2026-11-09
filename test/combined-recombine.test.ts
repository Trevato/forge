/** `recombine` (#10039): main moves, every kept-fork pull's combined branch follows, one pass at a time. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { combine, readFailure } from "../src/git/combined.ts";
import { idle, recombine, runsStarted } from "../src/core/recombine.ts";
import { getRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { tokenFor } from "./helpers/tokens.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Jay Moran",
  GIT_AUTHOR_EMAIL: "jay@f.dev",
  GIT_COMMITTER_NAME: "Jay Moran",
  GIT_COMMITTER_EMAIL: "jay@f.dev",
});

let dataDir = "";
let work = "";
let app: App;
let servers: Servers;
let base = "";
let alice = "";
let bob = "";
let repoId = "";
let bare = "";
const warnings: string[] = [];

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}
const call = (path: string, token: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const authed = (user: string, token: string) => base.replace("http://", `http://${user}:${token}@`);
async function signup(username: string): Promise<string> {
  await fetch(`${base}/signup`, {
    method: "POST",
    body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "kept-fork-pass" }),
    redirect: "manual",
  });
  return tokenFor(app, username, "admin", "k");
}
const forge = () => ({
  db: app.db,
  reposRoot: app.reposRoot,
  log: { ...app.log, warn: (m: string) => void warnings.push(m) },
});
const parents = async (ref: string) => (await git(["log", "-1", "--format=%P", ref], bare)).split(" ");

let a = "";
let b = "";
let first = 0;
let second = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-rc-"));
  work = await mkdtemp(join(tmpdir(), "forge-rc-work-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  alice = await signup("alice");
  bob = await signup("bob");
  proveAll(app);
  promote(app.db);
  await call("/api/v1/repos", alice, { name: "app", visibility: "public" });
  a = join(work, "a");
  b = join(work, "b");
  await git(["clone", `${authed("alice", alice)}/alice/app.git`, "a"], work);
  await Bun.write(join(a, "one.txt"), "one\n");
  await git(["add", "."], a);
  await git(["commit", "-m", "seed"], a);
  await git(["push", "origin", "main"], a);
  await call("/api/v1/repos/alice/app/forks", bob, {});
  await git(["clone", `${authed("bob", bob)}/bob/app.git`, "b"], work);
  for (const [branch, file] of [["one", "b1.txt"], ["two", "b2.txt"]] as const) {
    await git(["checkout", "-q", "-b", branch, "origin/main"], b);
    await Bun.write(join(b, file), `${branch}\n`);
    await git(["add", "."], b);
    await git(["commit", "-m", `bob ${branch}`], b);
    await git(["push", "origin", branch], b);
  }
  const open = async (head: string): Promise<number> => {
    const r = await call("/api/v1/repos/alice/app/pulls", bob, {
      title: head,
      base: "main",
      head,
      headRepo: "bob/app",
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { number: number }).number;
  };
  first = await open("one");
  second = await open("two");
  repoId = getRepo(app.db, "alice", "app")!.id;
  bare = repoDir(app.reposRoot, "alice", "app");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

async function moveMain(file: string): Promise<string> {
  await Bun.write(join(a, file), `${file}\n`);
  await git(["add", "."], a);
  await git(["commit", "-m", `main adds ${file}`], a);
  await git(["push", "origin", "main"], a);
  return git(["rev-parse", "HEAD"], a);
}

/** The pass the push itself starts (the hook began it before it answered), awaited. */
async function settled(main: string): Promise<string> {
  await idle(repoId);
  return main;
}

test("main moves, and every combined branch has the new main as a parent", async () => {
  const main = await settled(await moveMain("m1.txt"));
  expect(await recombine(forge(), repoId)).toBe(1);
  for (const n of [first, second]) expect((await parents(`refs/heads/combined/${n}`))[1]).toBe(main);
});

test("one pull that cannot combine is logged and skipped, the others still follow", async () => {
  await git(["update-ref", "-d", `refs/pull/${first}/head`], bare);
  const before = await git(["rev-parse", `refs/heads/combined/${first}`], bare);
  const main = await settled(await moveMain("m2.txt"));
  warnings.length = 0;
  await recombine(forge(), repoId);
  expect(warnings.length).toBe(1);
  expect(await git(["rev-parse", `refs/heads/combined/${first}`], bare)).toBe(before);
  expect((await parents(`refs/heads/combined/${second}`))[1]).toBe(main);
});

test("calls made during a pass share it: three at once run at most two passes", async () => {
  await settled(await moveMain("m3.txt"));
  const counts = await Promise.all([recombine(forge(), repoId), recombine(forge(), repoId), recombine(forge(), repoId)]);
  expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  expect(Math.max(...counts)).toBe(2);
});

test("a push to main alone recombines every combined branch, with no call made", async () => {
  const main = await moveMain("m4.txt");
  await idle(repoId);
  expect((await parents(`refs/heads/combined/${second}`))[1]).toBe(main);
});

test("a push to another branch, or a delete of the default branch, starts no pass", async () => {
  const runs = runsStarted(repoId);
  await git(["checkout", "-q", "-b", "side"], a);
  await git(["push", "origin", "side"], a);
  await git(["checkout", "-q", "main"], a);
  await idle(repoId);
  expect(runsStarted(repoId)).toBe(runs);
  // The forge lets a bare repository's checked-out branch be deleted only if git does.
  await git(["config", "receive.denyDeleteCurrent", "ignore"], bare);
  await git(["push", "origin", ":refs/heads/main"], a);
  await idle(repoId);
  expect(runsStarted(repoId)).toBe(runs);
  // The pass a push to main starts is counted: the check above can see one.
  await git(["push", "origin", "main"], a);
  await idle(repoId);
  expect(runsStarted(repoId)).toBe(runs + 1);
});

test("a failed rebuild is worded on the pull's combined card, and any good rebuild clears it", async () => {
  const card = async (): Promise<string> =>
    (await (await call(`/alice/app/pulls/${first}`, alice)).text()).replace(/&#39;/g, "'");
  const sentence = "The rebuild failed: the pull's head is missing from the repository.";
  const head = await git(["rev-parse", "refs/heads/one"], b);
  // This test makes its own state: a combined branch built on one main, the head ref then gone.
  await git(["update-ref", `refs/pull/${first}/head`, head], bare);
  await settled(await moveMain("f1.txt"));
  await git(["update-ref", "-d", `refs/pull/${first}/head`], bare);
  await moveMain("m5.txt");
  await idle(repoId);
  const failed = await card();
  expect(failed).toContain("Combined with main");
  expect(failed).toContain("stale");
  expect(failed).toContain(sentence);
  expect(failed).toContain("Push to the fork again to rebuild.");
  // A push to the fork rebuilds through combine() alone, not the recombine pass.
  await git(["update-ref", `refs/pull/${first}/head`, head], bare);
  const main = await git(["rev-parse", "refs/heads/main"], bare);
  expect(await combine(bare, { number: first, baseOid: main, headOid: head })).toBeDefined();
  expect(await readFailure(bare, first)).toBeUndefined();
  // Main moves again: the old sentence does not come back.
  await moveMain("m6.txt");
  await idle(repoId);
  const fixed = await card();
  expect(fixed).not.toContain(sentence);
  expect(fixed).not.toContain("stale");
});
