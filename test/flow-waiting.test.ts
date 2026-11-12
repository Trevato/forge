/** /flow's waiting section (#11455): one test per section on the page's HTML; quiet draws nothing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { repoDir } from "../src/git/repos.ts";
import { forgetUnproposed, readWaiting } from "../src/web/pages/flow-waiting.ts";
import { waitingLines } from "../src/tui/screens/waiting.ts";
import type { Session } from "../src/tui/session.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
let aliceId = "";
let botId = "";
let upstream: Repo;
let bot: User;
let alice: User;
let n = 0;

const page = async () => (await fetch(`${servers.url}/flow`, { headers: { cookie } })).text();
const git = async (cwd: string, args: string[], date: string, stdin?: string): Promise<string> => {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@f.dev", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@f.dev", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out.trim();
};
const pull = (author: string, body: string, createdAt: string, repo = repoId, number?: number, branch?: string): { issueId: string; number: number } => {
  const issueId = id();
  n += 1;
  const num = number ?? 100 + n;
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', ?4, ?5, 'open', ?6)`)
    .run(issueId, repo, num, body, author, createdAt);
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, '', ?3, ?4)`)
    .run(issueId, branch ?? `br-${String(n)}`, `oid-${String(n)}`, repo);
  return { issueId, number: num };
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-waiting-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = must(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true }));
  aliceId = alice.id;
  bot = must(await createUser(app.db, { origin: "seed", trusted: true, username: "bot", email: "bot@f.dev", agent: true }));
  botId = bot.id;
  upstream = must(await createRepo(app, alice, { name: "app", visibility: "public" }));
  repoId = upstream.id;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a quiet lane draws no waiting card", async () => {
  const html = await page();
  expect(html).not.toContain('id="flow-waiting"');
  expect(html).not.toContain("flow-approved");
  expect(html).not.toContain("flow-stale");
  expect(html).not.toContain("flow-unproposed");
});

test("an approval followed by changes requested keeps the lane quiet", async () => {
  const p = pull(botId, "", ago(5));
  app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'approved', ?4)`).run(id(), p.issueId, aliceId, ago(4));
  app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'changes_requested', ?4)`).run(id(), p.issueId, aliceId, ago(3));
  expect((await readWaiting(app.db, app.reposRoot, new Date())).approved).toEqual([]);
  expect(await page()).not.toContain("flow-approved");
  app.db.query("DELETE FROM review WHERE issue_id = ?1").run(p.issueId);
  app.db.query("DELETE FROM pull WHERE issue_id = ?1").run(p.issueId);
  app.db.query("DELETE FROM issue WHERE id = ?1").run(p.issueId);
});

test("approved pulls waiting are counted per repository with the oldest", async () => {
  for (const h of [3, 30]) {
    const p = pull(botId, "", ago(50));
    app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'approved', ?4)`).run(id(), p.issueId, aliceId, ago(h));
  }
  const html = await page();
  expect(html).toContain('id="flow-approved"');
  expect(html).toContain("2 approved pulls waiting");
  expect(html).toContain("alice/app");
  expect(html).toContain("for 30 h");
});

test("a stale crew pull shows the note that folds it back, and a fresh one does not", async () => {
  const stale = pull(botId, "Closes #7", ago(24 * 9));
  pull(botId, "Closes #8", ago(2));
  const html = await page();
  expect(html).toContain('id="flow-stale"');
  expect(html).toContain(`/alice/app/pulls/${String(stale.number)}`);
  expect(html).toContain("Folded back: pull #" + String(stale.number) + " had no push for 9 days");
  expect(html).toContain("/alice/app/issues/7");
  expect(html).not.toContain("/alice/app/issues/8");
});

test("a crew fork branch that heads no pull is shown once with a link to the branch", async () => {
  const up = repoDir(app.reposRoot, "alice", "app");
  const empty = await git(up, ["hash-object", "-t", "tree", "-w", "--stdin"], ago(40), "");
  const main = await git(up, ["commit-tree", empty, "-m", "root"], ago(40));
  await git(up, ["update-ref", `refs/heads/${upstream.defaultBranch}`, main], ago(40));
  must(await forkRepo(app, bot, upstream));
  const dir = repoDir(app.reposRoot, "bot", "app");
  const tree = await git(dir, ["rev-parse", `${main}^{tree}`], ago(7));
  const oid = await git(dir, ["commit-tree", tree, "-p", main, "-m", "lonely"], ago(7));
  await git(dir, ["update-ref", "refs/heads/lonely", oid], ago(7));
  forgetUnproposed();
  const html = await page();
  expect(html).toContain('id="flow-unproposed"');
  expect(html.split('href="/bot/app/tree/lonely"').length).toBe(2);
});

test("the unproposed scan is held for a minute, then read again", async () => {
  forgetUnproposed();
  const t = new Date();
  expect((await readWaiting(app.db, app.reposRoot, t)).unproposed.fires).toBe(true);
  const dir = repoDir(app.reposRoot, "bot", "app");
  await git(dir, ["update-ref", "-d", "refs/heads/lonely"], ago(1));
  expect((await readWaiting(app.db, app.reposRoot, new Date(t.getTime() + 5_000))).unproposed.fires).toBe(true);
  expect((await readWaiting(app.db, app.reposRoot, new Date(t.getTime() + 61_000))).unproposed.fires).toBe(false);
});

test("a stale pull keeps its own repository when two repositories share a number and a branch", async () => {
  const other = must(await createRepo(app, alice, { name: "second", visibility: "public" }));
  pull(botId, "Closes #1", ago(24 * 20), repoId, 900, "same-branch");
  pull(botId, "Closes #1", ago(24 * 10), other.id, 900, "same-branch");
  const w = await readWaiting(app.db, app.reposRoot, new Date());
  const mine = w.stale.filter((s) => s.number === 900);
  expect(mine.map((s) => s.repo).sort()).toEqual(["alice/app", "alice/second"]);
  expect(mine.find((s) => s.repo === "alice/app")?.days).toBe(20);
  expect(mine.find((s) => s.repo === "alice/second")?.days).toBe(10);
});

test("a non-admin, a guest and a crew member get no waiting card on the page", async () => {
  const bob = must(await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@f.dev", password: "a-good-passphrase" }));
  expect(bob.isAdmin).toBe(false);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
  });
  const bobCookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  for (const headers of [{ cookie: bobCookie }, {}]) {
    const r = await fetch(`${servers.url}/flow`, { headers, redirect: "manual" });
    const text = await r.text();
    expect(text).not.toContain("flow-waiting");
    expect(text).not.toContain("Stale crew pulls");
    expect(text).not.toContain("Approved, waiting");
  }
});

test("the terminal lists the three sections for an admin only", async () => {
  const w = await readWaiting(app.db, app.reposRoot, new Date());
  const as = (user: User | undefined) => ({ user }) as unknown as Session;
  const lines = waitingLines(as(alice), w);
  expect(lines).toContain("Approved, waiting on the merge queue");
  expect(lines).toContain("Stale crew pulls");
  expect(waitingLines(as(bot), w)).toEqual([]);
  expect(waitingLines(as(undefined), w)).toEqual([]);
  const bob = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'bob'").get();
  expect(bob).not.toBeNull();
  expect(waitingLines({ user: { ...alice, isAdmin: false } } as unknown as Session, w)).toEqual([]);
});
