/** An app home's `now` and `following` read in batches: 200 issues, 40 pulls, 5 runs (#6184). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { forkRelation } from "../src/core/following.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
const PAGES = ["/alice/vault", "/alice/vault-fork"];
/** Statements a page cost with few rows. */
const small: Record<string, number> = {};

/**
 * Per-row probes the page makes today (#6819 batches them and removes this list),
 * one per visible pull and per run: the repo-visibility check, the sealed check
 * and the issue-by-id read. They are a known cost this test does not pin; every other statement must not grow with the rows.
 */
const PER_ROW_TODAY = [/^\s*SELECT 1 AS n FROM repo WHERE repo\.id = \?1 AND NOT EXISTS/, /^SELECT sealed, author_id FROM issue WHERE id = \?1/, /^\s*SELECT issue\.\*, user\.username AS author_name.* WHERE issue\.id = \?1\s*$/s];

/** SQL statements one signed-in GET prepares: load-independent, unlike its milliseconds. */
async function queriesFor(path: string): Promise<number> {
  const db = app.db as unknown as { query: (sql: string) => unknown };
  const real = db.query;
  let n = 0;
  db.query = function (this: unknown, sql: string) {
    if (!PER_ROW_TODAY.some((re) => re.test(sql))) n++;
    return real.call(this, sql);
  };
  try {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    if (path.endsWith("-fork")) expect(body.replace(/\s+/g, " ")).toContain("needs a decision");
  } finally {
    db.query = real;
  }
  return n;
}


beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-home-batched-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "vault" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, u.value, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "v\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const enabled = await enableApp(app, u.value, made.value, { slug: "vault" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  const forked = await forkRepo(app, u.value, made.value, "vault-fork");
  if (!forked.ok) throw new Error(String(forked.error));
  const enabledFork = await enableApp(app, u.value, forked.value, { slug: "vault-fork" });
  if (!enabledFork.ok) throw new Error(String(enabledFork.error));
  // Both sides edit the same line: diverged, and git cannot merge them.
  for (const [repo, content] of [[forked.value, "fork\n"], [made.value, "parent\n"]] as const) {
    const moved = await commitToBranch(app, u.value, repo, {
      message: "Edit",
      files: [{ path: "README.md", content }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  }
  // The parent's push is followed as it lands; wait for the fork to read diverged.
  for (let i = 0; i < 100; i++) {
    const relation = await forkRelation(app, forked.value);
    if (relation?.state === "diverged") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const db = app.db;
  const agent = db.query<{ id: string }, []>("SELECT id FROM user WHERE kind = 'agent' LIMIT 1").get();
  const assignee = agent?.id ?? u.value.id;
  const repoIds = [made.value.id, forked.value.id];
  // Rows are added in two steps: a few, measured; then up to 200/40/5, measured again.
  const seed = (issues: [number, number], pulls: [number, number], runs: [number, number]) =>
    db.transaction(() => {
      for (const repoId of repoIds) {
        for (let i = issues[0]; i < issues[1]; i++) {
          db.query(
            `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, assignee_id, state)
             VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, ?6, 'open')`,
          ).run(`${repoId}i${i}`, repoId, 1 + i, `Tell ${i}`, u.value.id, i % 2 === 0 ? assignee : null);
        }
        for (let i = pulls[0]; i < pulls[1]; i++) {
          db.query(
            `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
             VALUES (?1, ?2, ?3, 'pull', ?4, ?5, ?6, 'open')`,
          ).run(`${repoId}p${i}`, repoId, 1000 + i, `Pull ${i}`, `Closes #${i + 1}`, u.value.id);
          db.query(
            `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
             VALUES (?1, 'main', ?2, 'x', 'y')`,
          ).run(`${repoId}p${i}`, `b${i}`);
        }
        for (let i = runs[0]; i < runs[1]; i++)
          db.query(
            `INSERT INTO run (id, repo_id, kind, state, issue_id) VALUES (?1, ?2, 'agent', 'running', ?3)`,
          ).run(`${repoId}r${i}`, repoId, `${repoId}i${i * 2 + 1}`);
      }
    })();
  seed([0, 10], [0, 2], [0, 1]);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  for (const path of PAGES) {
    await queriesFor(path); // warm caches
    small[path] = await queriesFor(path);
  }
  seed([10, 200], [2, 40], [1, 5]);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

// A page may take a statement or two more once a list is long (a "more" link);
// a loop adds one per row, at least 38 here.
const SLACK = 3;

// Batched reads cost the same however many rows there are: a statement per
// issue, pull or run would make the 200/40/5 page cost more than the 10/2/1 one.
test("now reads its rows in batches with 200 open issues, 40 open pulls and 5 active runs", async () => {
  const path = "/alice/vault";
  await queriesFor(path);
  expect(Math.abs((await queriesFor(path)) - small[path]!)).toBeLessThanOrEqual(SLACK);
});

test("following stays cheap on a diverged fork (regression guard; this pull does not change it)", async () => {
  const path = "/alice/vault-fork";
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(res.headers.get("server-timing") ?? "").toContain("following");
  await queriesFor(path);
  expect(Math.abs((await queriesFor(path)) - small[path]!)).toBeLessThanOrEqual(SLACK);
});
