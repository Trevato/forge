/** 40 busy apps: the shelf asks git once for production's ancestry and never again until production moves; the whole shelf costs a bounded number of statements (#6290, for #6179). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import type { Ctx } from "../src/http/context.ts";
import { ancestries } from "../src/web/studio/ancestry.ts";
import { shelfRows } from "../src/web/studio/shelf.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let root = "";
let app: App;
let alice: User;
let runtime: AppsRuntime;
const repos: Repo[] = [];
let real: Repo;
// biome-ignore lint: reaching the runtime's own table is how a test seeds an environment
let realState: any;
let realDeploy = "";

const ctx = (): Ctx => ({
  app,
  request: new Request("http://forge.test/apps"),
  url: new URL("http://forge.test/apps"),
  params: {},
  auth: { user: alice, scope: undefined, via: "session" },
  theme: undefined,
});

/** A pull written straight into the database: git history is not what the shelf tests are about. */
function seedPull(repo: Repo, merged: string | null, head: string): void {
  const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "work", kind: "pull" });
  if (!issue.ok) throw new Error(issue.error);
  app.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, 'main', 'work', ?2, ?3, ?4, ?5, ?6)")
    .run(issue.value.id, "0".repeat(40), head, repo.id, merged === null ? null : new Date().toISOString(), merged);
}

function seedRuns(repo: Repo, serving: string, branch: string): string {
  const agent = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "tell", branch });
  claimRun(app.db, agent.id);
  finishRun(app.db, agent.id, { state: "ok", summary: "done" });
  const deploy = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production", commitOid: serving, reason: "push" });
  claimRun(app.db, deploy.id);
  finishRun(app.db, deploy.id, { state: "ok", summary: "deployed" });
  return deploy.id;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-shelf-forty-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  proveAll(app);
  runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: 80, forgeUrl: "http://forge.test", concurrency: 1 });
  for (let i = 0; i < 41; i++) {
    const isReal = i === 40;
    const made = await createRepo(app, alice, { name: `app-${String(i).padStart(2, "0")}`, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const enabled = enableApp(app, alice, made.value, { slug: `app-${i}` });
    if (!enabled.ok) throw new Error(String(enabled.error));
    repos.push(made.value);
    // biome-ignore lint: as above
    const state = (runtime as any).envFor(enabled.value, "production");
    if (isReal) {
      // The one app whose production is behind a real history: a merged
      // change, and a later commit that production serves.
      real = made.value;
      const first = await commitToBranch(app, alice, real, { message: "first", files: [{ path: "a.txt", content: "a" }] });
      const later = await commitToBranch(app, alice, real, { message: "later", files: [{ path: "b.txt", content: "b" }] });
      if (!first.ok || !later.ok) throw new Error("commit");
      seedPull(real, first.value.commitOid, first.value.commitOid);
      realDeploy = seedRuns(real, later.value.commitOid, "work");
      state.asleep = { commitOid: later.value.commitOid, dir: root, manifest: {}, runId: realDeploy, since: new Date().toISOString() };
      realState = state;
      continue;
    }
    // Even apps keep their change open; odd apps merged it and production serves it.
    const oid = String(i).padStart(2, "0").repeat(20);
    seedPull(made.value, i % 2 === 1 ? oid : null, oid);
    const deployId = seedRuns(made.value, oid, "work");
    state.asleep = { commitOid: oid, dir: root, manifest: {}, runId: deployId, since: new Date().toISOString() };
  }
}, 30_000);
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("the second draw of the shelf never asks git; a new production commit does, once", async () => {
  await shelfRows(ctx(), repos);
  const first = ancestries.reads;
  expect(first).toBeGreaterThanOrEqual(1);
  await shelfRows(ctx(), repos);
  expect(ancestries.reads).toBe(first);
  // A deploy lands: production now serves a commit nobody has asked about.
  const newest = await commitToBranch(app, alice, real, { message: "newest", files: [{ path: "c.txt", content: "c" }] });
  if (!newest.ok) throw new Error("commit");
  realState.asleep = { ...realState.asleep, commitOid: newest.value.commitOid };
  await shelfRows(ctx(), repos);
  expect(ancestries.reads).toBe(first + 1);
  await shelfRows(ctx(), repos);
  expect(ancestries.reads).toBe(first + 1);
});

test("a viewer who cannot enter a private app causes no read about it", async () => {
  const before = ancestries.reads;
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(real.id);
  app.db.query("UPDATE app SET access = 'private' WHERE repo_id = ?1").run(real.id);
  const c = { ...ctx(), auth: { user: bob.value, scope: undefined, via: "session" as const } };
  try {
    const rows = (await shelfRows(c, [real])).map(String);
    expect(rows[0]).toContain("private app");
    expect(ancestries.reads).toBe(before);
  } finally {
    app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?1").run(real.id);
    app.db.query("UPDATE app SET access = 'public' WHERE repo_id = ?1").run(real.id);
  }
});

test("41 busy apps are drawn in a bounded number of statements", async () => {
  await shelfRows(ctx(), repos);
  // Measured, not timed: 70 statements for 41 busy apps today, a read or two per app. A regression to
  // several statements per app (or an unbatched read) lands well past this.
  expectWork(await statements(app.db, async () => void (await shelfRows(ctx(), repos))), { max: 72 });
});
