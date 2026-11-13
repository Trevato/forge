/**
 * After a new forge's first ask the card says who took it and what they do,
 * or exactly what is missing, or where it waits (#11788).
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { askStatus, askStatusLine } from "../src/core/ask-status.ts";
import { askBlock, besideAsk } from "../src/web/pages/next-steps.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

let dir: string;
let app: App;
const KEY = "ANTHROPIC_API_KEY";
const saved = process.env[KEY];

beforeAll(async () => {
  delete process.env[KEY];
  dir = await mkdtemp(join(tmpdir(), "forge-ask-status-"));
  app = createApp({ dataDir: dir, port: 0 });
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "maria", email: "m@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error("user");
  if (!(await createAgent(app, r.value, { username: "atlas" })).ok) throw new Error("agent");
});
afterAll(async () => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  app.close();
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
/** A fresh app with one open ask; `build` may assign the builder and start a run. */
async function asked(build?: "running" | "queued") {
  const maria = getUserByName(app.db, "maria")!;
  const atlas = getUserByName(app.db, "atlas")!;
  const made = await createRepo(app, maria, { name: `menu${++n}`, visibility: "private" });
  if (!made.ok) throw new Error("repo");
  const issue = openIssue(app, maria, made.value, { title: "A weekly menu page" });
  if (!issue.ok) throw new Error("issue");
  if (build) addToCrew(app, maria, made.value, "atlas");
  if (build) assignIssue(app, maria, made.value, issue.value, atlas);
  if (build === "running" || build === "queued") {
    // Assigning may already have queued the builder's run; if not, queue one.
    const queued = app.db.query<{ id: string }, [string]>("SELECT id FROM run WHERE issue_id = ?1 AND kind = 'agent' ORDER BY id DESC LIMIT 1").get(issue.value.id);
    const run = queued ?? createRun(app.db, { repoId: made.value.id, kind: "agent", issueId: issue.value.id, actorId: atlas.id, reason: "assigned" });
    if (build === "running") claimRun(app.db, run.id);
  }
  return { repo: made.value, issue: issue.value };
}
const status = (repo: Awaited<ReturnType<typeof asked>>["repo"], admin = true, canRun = !!process.env[KEY]) =>
  askStatus(app.db, [repo], getUserByName(app.db, "maria")!.id, canRun, admin);

test("a builder on it: their name and that they are building it, naming the app and issue", async () => {
  process.env[KEY] = "sk-test";
  const a = await asked("running");
  const s = status(a.repo)!;
  expect(s).toMatchObject({ state: "building", says: "atlas is building it" });
  expect(s.app).toBe(a.repo.name);
  expect(s.issueNumber).toBe(a.issue.number);
  expect(s.href).toBe(`/${a.repo.ownerName}/${a.repo.name}/issues/${a.issue.number}`);
});

test("nothing to run on: the one thing missing, in plain words, with its action", async () => {
  delete process.env[KEY];
  const a = await asked();
  expect(status(a.repo)).toMatchObject({ says: "No AI account and no included credit left: add a key", action: { href: "/settings/subscriptions" } });
  expect(status(a.repo, false)?.action?.href).toBe("/pricing");
});

test("no run yet: waiting for a builder, with no number", async () => {
  process.env[KEY] = "sk-test";
  const waiting = status((await asked()).repo)!;
  expect(waiting).toMatchObject({ state: "waiting", says: "Waiting for a builder" });
  expect(waiting.says).not.toMatch(/\d/);
});

test("a queued run: its real place among the queued runs made before it on the person's apps", async () => {
  process.env[KEY] = "sk-test";
  const alone = await asked("queued");
  expect(status(alone.repo)).toMatchObject({ state: "queued", says: "Next in line for a builder" });
  // Two runs queued earlier on the person's other app, one later: two ahead, the later one not counted.
  const a = await asked();
  const other = await asked();
  const atlas = getUserByName(app.db, "atlas")!;
  const queue = (repo: typeof a.repo, issueId: string, at: string) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId, actorId: atlas.id, reason: "assigned" });
    app.db.query("UPDATE run SET created_at = ?2 WHERE id = ?1").run(run.id, at);
  };
  queue(other.repo, other.issue.id, "2000-01-01T00:00:01.000Z");
  queue(other.repo, other.issue.id, "2000-01-01T00:00:02.000Z");
  queue(a.repo, a.issue.id, "2000-01-01T00:00:03.000Z");
  queue(other.repo, other.issue.id, "2000-01-01T00:00:04.000Z");
  app.db.query("UPDATE issue SET created_at = 0 WHERE id = ?1").run(a.issue.id);
  expect(askStatus(app.db, [a.repo, other.repo], getUserByName(app.db, "maria")!.id, true, true)).toMatchObject({ state: "queued", says: "Waiting for a builder: 2 ahead of it", issueNumber: a.issue.number });
  // Scoped to the person's apps: the same ask, looked at alone, is next.
  expect(status(a.repo)!.says).toBe("Next in line for a builder");
});

/** An ask whose builder's run ended in `state`. */
async function ended(state: "failed" | "cancelled" | "ok") {
  const a = await asked("running");
  app.db.query("UPDATE run SET state = ?2, branch = ?3 WHERE issue_id = ?1 AND kind = 'agent'").run(a.issue.id, state, `atlas/${a.issue.number}-${state}`);
  return a;
}

test("a run that ended without a pull says how, in plain words, never that it waits", async () => {
  process.env[KEY] = "sk-test";
  expect(status((await ended("failed")).repo)).toMatchObject({ state: "stopped", says: "atlas stopped on it: the run failed" });
  expect(status((await ended("cancelled")).repo)).toMatchObject({ state: "cancelled", says: "atlas's run on it was cancelled" });
  expect(status((await ended("ok")).repo)).toMatchObject({ state: "finished", says: "atlas finished a run on it and opened no pull" });
});

test("the status ends with the first ask: once it has a pull, or is closed, or a later ask is all that is open", async () => {
  process.env[KEY] = "sk-test";
  const a = await ended("ok");
  const maria = getUserByName(app.db, "maria")!;
  const pr = openIssue(app, maria, a.repo, { title: "The weekly menu page" });
  if (!pr.ok) throw new Error("issue");
  app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(pr.value.id);
  app.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, '', '', ?3)")
    .run(pr.value.id, `atlas/${a.issue.number}-ok`, a.repo.id);
  expect(status(a.repo)).toBeNull();

  const b = await asked();
  const later = openIssue(app, maria, b.repo, { title: "Another thing" });
  if (!later.ok) throw new Error("issue");
  app.db.query("UPDATE issue SET created_at = created_at + 5000 WHERE id = ?1").run(later.value.id);
  app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(b.issue.id);
  expect(status(b.repo)).toBeNull();
});

test("the first ask is the oldest open one: a later issue does not replace it", async () => {
  process.env[KEY] = "sk-test";
  const a = await asked();
  const maria = getUserByName(app.db, "maria")!;
  const later = openIssue(app, maria, a.repo, { title: "Another thing" });
  if (!later.ok) throw new Error("issue");
  app.db.query("UPDATE issue SET created_at = created_at + 5000 WHERE id = ?1").run(later.value.id);
  expect(status(a.repo)!.issueNumber).toBe(a.issue.number);
});

test("the card's missing-key action is one quiet link, never a second primary, for an admin and for a person", async () => {
  delete process.env[KEY];
  const a = await asked();
  const admin = String(askBlock(status(a.repo, true)!));
  expect(admin).toContain('href="/settings/subscriptions"');
  expect(admin).toContain("Add a model key");
  expect(admin).not.toContain('data-variant="primary"');
  const person = String(askBlock(status(a.repo, false)!));
  expect(person).toContain('href="/pricing"');
  expect(person).toContain("See the plans");
  expect(person).not.toContain("/settings/subscriptions");
  expect(person).not.toContain('data-variant="primary"');
});

test("the terminal's line says the same words, the app and issue, and the action", async () => {
  delete process.env[KEY];
  const a = await asked();
  const line = askStatusLine(status(a.repo)!);
  expect(line).toBe(`No AI account and no included credit left: add a key (${a.repo.name}, issue #${a.issue.number}). Add a model key at /settings/subscriptions`);
});

test("a builder at work is said once: while the ask is building, its app's crew row goes; otherwise it stays", async () => {
  process.env[KEY] = "sk-test";
  const building = await asked("running");
  const other = await asked();
  const repos = [building.repo, other.repo];
  expect(besideAsk(repos, status(building.repo)).map((r) => r.id)).toEqual([other.repo.id]);
  expect(besideAsk(repos, status(other.repo)).map((r) => r.id)).toEqual(repos.map((r) => r.id));
  expect(besideAsk(repos, null)).toHaveLength(2);
});
