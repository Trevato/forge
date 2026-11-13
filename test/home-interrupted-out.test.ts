/** Home names a run given up after interruptions, with Try again (#11583). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { interruptedOutRuns } from "../src/runs/interrupted_out.ts";
import { interruptedOutScreen } from "../src/tui/screens/interrupted_out.ts";
import { getRepo } from "../src/core/repos.ts";
import { INTERRUPTED_OUT, STOPPED_TWICE_LEGACY } from "../src/crew/dispatch.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let cookie: string;
let repoId: string;
let botId: string;

const home = async () => (await fetch(`${servers.url}/`, { headers: { cookie } })).text();

function failedRun(title: string, summary: string, finishedAt: string) {
  const made = createIssue(app.db, { repoId, authorId: alice.id, title, kind: "issue" });
  if (!made.ok) throw new Error(made.error);
  const id = `0000-${crypto.randomUUID()}`;
  app.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, summary, actor_id, finished_at) VALUES (?, ?, 'agent', ?, 'c', 'failed', ?, ?, ?)")
    .run(id, repoId, made.value.id, summary, botId, finishedAt);
  return { id, issue: made.value };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-interrupted-out-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
  promote(app.db, alice);
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const made = await newApp(app, alice, { name: "shop", description: "Words", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = getRepo(app.db, "alice", "shop")!.id;
  const bot = await createAgent(app, alice, { username: "bot", brief: "Be brief." });
  if (!bot.ok) throw new Error(String(bot.error));
  botId = bot.value.user.id;
  if (!addToCrew(app, alice, getRepo(app.db, "alice", "shop")!, "bot").ok) throw new Error("crew");
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("no line when no run was stopped twice", async () => {
  expect(await home()).not.toContain("interrupted-out");
});

test("a run stopped twice lately shows one line with its reason and Try again; old, other, or retried runs show none", async () => {
  failedRun("Old one", INTERRUPTED_OUT, new Date(Date.now() - 25 * 3600_000).toISOString());
  failedRun("Other failure", "tests failed", new Date().toISOString());
  const again = failedRun("Already retried", INTERRUPTED_OUT, new Date(Date.now() - 1000).toISOString());
  app.db.query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES ('zzzzz-newer', ?, 'agent', ?, 'c', 'queued')").run(repoId, again.issue.id);
  const hit = failedRun("Fix <b>the</b> thing", INTERRUPTED_OUT, new Date().toISOString());
  const page = await home();
  expect(page).toContain('id="interrupted-out"');
  expect(page).toContain(INTERRUPTED_OUT);
  expect(page).toContain(`action="/alice/shop/runs/${hit.id}/requeue"`);
  expect(page).toContain("Try again");
  expect(page).toContain("Fix &lt;b&gt;the&lt;/b&gt; thing");
  expect(page).not.toContain("Fix <b>the</b>");
  expect(page.match(/\/requeue"/g)?.length).toBe(1);
});

test("a run failed under the old \"stopped twice\" text still shows", async () => {
  const hit = failedRun("Old words", STOPPED_TWICE_LEGACY, new Date().toISOString());
  const repo = getRepo(app.db, "alice", "shop")!;
  const row = interruptedOutRuns(app.db, [repo]).find((r) => r.runId === hit.id);
  expect(row?.reason).toBe(STOPPED_TWICE_LEGACY);
  expect(await home()).toContain(`/runs/${hit.id}/requeue`);
});

test("a stranger sees no line", async () => {
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!r.ok) throw new Error(r.error);
  const bob = `forge_session=${createSession(app.db, r.value.id).token}`;
  expect(await (await fetch(`${servers.url}/`, { headers: { cookie: bob } })).text()).not.toContain("interrupted-out");
});

test("the Try again route refuses a cross-origin post", async () => {
  const run = app.db.query<{ id: string }, []>("SELECT id FROM run WHERE summary LIKE 'the host stopped%' ORDER BY id DESC LIMIT 1").get()!;
  const res = await fetch(`${servers.url}/alice/shop/runs/${run.id}/requeue`, {
    method: "POST",
    headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: "",
    redirect: "manual",
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
});

const post = (path: string, who: string) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { cookie: who, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
    body: "",
    redirect: "manual",
  });
const runsOf = (issueId: string) => app.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM run WHERE issue_id = ? AND kind = 'agent'").get(issueId)!.n;

test("a signed-in non-writer's same-origin post queues nothing", async () => {
  const hit = failedRun("Not for bob", INTERRUPTED_OUT, new Date().toISOString());
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
  if (!r.ok) throw new Error(r.error);
  const carol = `forge_session=${createSession(app.db, r.value.id).token}`;
  const res = await post(`/alice/shop/runs/${hit.id}/requeue`, carol);
  expect(res.status).toBeLessThan(500);
  expect(runsOf(hit.issue.id)).toBe(1);
  expect(await home()).toContain(`/runs/${hit.id}/requeue`);
});

test("a writer's same-origin post queues a new run and the line goes away", async () => {
  const hit = failedRun("Retry me", INTERRUPTED_OUT, new Date().toISOString());
  expect(await home()).toContain(`/runs/${hit.id}/requeue`);
  const res = await post(`/alice/shop/runs/${hit.id}/requeue`, cookie);
  expect(res.status).toBe(303);
  expect(runsOf(hit.issue.id)).toBe(2);
  expect(await home()).not.toContain(`/runs/${hit.id}/requeue`);
});

test("the terminal screen lists the same runs and Enter tries one again", async () => {
  const hit = failedRun("Retry from terminal", INTERRUPTED_OUT, new Date().toISOString());
  const repo = getRepo(app.db, "alice", "shop")!;
  expect(interruptedOutRuns(app.db, [repo]).some((r) => r.runId === hit.id)).toBe(true);
  const toasts: string[] = [];
  const ctx = { theme: { c: {} }, pop() {}, push() {}, invalidate() {}, toast: (t: string) => toasts.push(t) };
  const screen = interruptedOutScreen({ app, user: alice } as never, ctx as never);
  // Newest first: the run just made is the first row.
  expect(screen.key!({ key: "enter", ctrl: false, alt: false } as never)).toBe(true);
  expect(toasts[0]).toContain("again");
  expect(runsOf(hit.issue.id)).toBe(2);
  expect(await home()).not.toContain(`/runs/${hit.id}/requeue`);
});
