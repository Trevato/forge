/** The filed "waiting" issue names the oldest waiting pulls, not the red ones. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { fileOnce } from "../src/flow/keeper.ts";
import { oldestWaitingOn } from "../src/flow/pile.ts";

let root: string;
let app: App;
let repoId: string;
let agent: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-oldest-"));
  app = createApp({ dataDir: root, port: 0 });
  const o = await createUser(app.db, { username: "trevato", email: "t@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!o.ok) throw new Error(o.error);
  const a = await createUser(app.db, { origin: "seed", username: "atlas", email: "atlas@forge.test", agent: true });
  if (!a.ok) throw new Error("agent");
  agent = a.value.id;
  createAgentRow(app.db, { userId: agent, brief: "plan", createdBy: o.value.id });
  const r = await createRepo(app.db, app.reposRoot, { ownerId: o.value.id, name: "open", visibility: "public", description: "r" });
  if (!r.ok) throw new Error(r.error);
  repoId = r.value.id;
  addCrew(app.db, repoId, agent, o.value.id);
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const refs = (limit: number, publicOnly = true): string[] => oldestWaitingOn(app.db, limit, publicOnly).map((w) => w.ref);

function pull(number: number, createdAt: string): string {
  const issue = id();
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', '', ?4, 'open', ?5)`)
    .run(issue, repoId, number, agent, createdAt);
  app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'b', '', 'h', ?2)`).run(issue, repoId);
  return issue;
}

test("oldest first, red pulls left out, capped at the limit", () => {
  pull(1, "2026-11-01T00:00:00.000Z");
  const red = pull(2, "2026-11-01T01:00:00.000Z");
  pull(3, "2026-11-01T02:00:00.000Z");
  pull(4, "2026-11-01T03:00:00.000Z");
  app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, reason) VALUES ('0001x', ?1, 'check', ?2, 'h', 'failed', '')`).run(repoId, red);
  expect(refs(2)).toEqual(["trevato/open#1", "trevato/open#3"]);
  expect(refs(10)).toEqual(["trevato/open#1", "trevato/open#3", "trevato/open#4"]);
  expect(refs(0)).toEqual([]);
});

test("a conflicted pull is left out", () => {
  const c = pull(5, "2026-11-01T04:00:00.000Z");
  app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, state, reason, created_at) VALUES ('0002x', ?1, 'agent', ?2, 'queued', 'conflict', '2026-11-02T00:00:00.000Z')`).run(repoId, c);
  expect(refs(10)).toEqual(["trevato/open#1", "trevato/open#3", "trevato/open#4"]);
});

test("a private repository is left out by default, named only when asked", async () => {
  const o = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'trevato'").get()!;
  const r = await createRepo(app.db, app.reposRoot, { ownerId: o.id, name: "secret", visibility: "private", description: "r" });
  if (!r.ok) throw new Error(r.error);
  addCrew(app.db, r.value.id, agent, o.id);
  const issue = id();
  app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, 1, 'pull', 't', '', ?3, 'open', '2026-10-01T00:00:00.000Z')`).run(issue, r.value.id, agent);
  app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'b', '', 'h', ?2)`).run(issue, r.value.id);
  expect(refs(1)).toEqual(["trevato/open#1"]);
  expect(refs(1, false)).toEqual(["trevato/secret#1"]);
});

test("the filed stale_pile issue lists the oldest waiting pulls, and names private ones only in a private repository", () => {
  const was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "trevato/open";
  try {
    app.db.query("UPDATE repo SET issue_seq = 100 WHERE name = 'open'").run();
    const rate = { lastHour: 0, recent: 0.5, best: 3, ranShare: 1 };
    const body = (): string => app.db.query<{ body: string }, []>("SELECT body FROM issue WHERE title LIKE 'Throughput:%' ORDER BY created_at DESC, rowid DESC LIMIT 1").get()!.body;
    fileOnce(app, { cause: "stale_pile", says: "Open crew pulls wait." }, rate, Date.now());
    expect(body()).toContain("Oldest waiting, start here:\n- trevato/open#1 (waits on a reviewer)\n- trevato/open#3 (waits on a reviewer)\n- trevato/open#4 (waits on a reviewer)");
    expect(body()).not.toContain("secret");
    app.db.query("UPDATE repo SET visibility = 'private' WHERE name = 'open'").run();
    fileOnce(app, { cause: "stale_pile", says: "Open crew pulls wait again." }, rate, Date.now());
    expect(body()).toContain("- trevato/secret#1 (waits on a reviewer)");
  } finally {
    if (was === undefined) delete process.env.FORGE_SENTINEL_REPO;
    else process.env.FORGE_SENTINEL_REPO = was;
  }
});

test("each waiting pull names what it waits on: no verdict a reviewer, changes asked a builder, approved the merge", () => {
  const ids = app.db.query<{ id: string; number: number }, []>("SELECT i.id, i.number FROM issue i JOIN repo r ON r.id = i.repo_id WHERE r.name = 'open' AND i.number IN (3, 4)").all();
  const by = new Map(ids.map((r) => [r.number, r.id]));
  const rev = (n: string, issue: string, state: string, at: string): void => {
    app.db.query(`INSERT INTO review (id, issue_id, author_id, state, body, created_at) VALUES (?1, ?2, ?3, ?4, '', ?5)`).run(n, issue, agent, state, at);
  };
  rev("rv1", by.get(3)!, "changes_requested", "2026-11-03T00:00:00.000Z");
  rev("rv2", by.get(4)!, "changes_requested", "2026-11-03T00:00:00.000Z");
  rev("rv3", by.get(4)!, "approved", "2026-11-04T00:00:00.000Z");
  expect(oldestWaitingOn(app.db, 10, false).filter((w) => w.ref.startsWith("trevato/open#"))).toEqual([
    { ref: "trevato/open#1", on: "a reviewer" },
    { ref: "trevato/open#3", on: "a builder" },
    { ref: "trevato/open#4", on: "the merge" },
  ]);
});

test("a changes_requested after an approval reads as a builder", () => {
  const issue = app.db.query<{ id: string }, []>("SELECT i.id FROM issue i JOIN repo r ON r.id = i.repo_id WHERE r.name = 'open' AND i.number = 4").get()!.id;
  app.db.query(`INSERT INTO review (id, issue_id, author_id, state, body, created_at) VALUES ('rv4', ?1, ?2, 'changes_requested', '', '2026-11-05T00:00:00.000Z')`).run(issue, agent);
  expect(oldestWaitingOn(app.db, 10, false).find((w) => w.ref === "trevato/open#4")?.on).toBe("a builder");
});
