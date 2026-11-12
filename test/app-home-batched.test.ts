/** An app home's `now` and `following` read in batches: 200 issues, 40 pulls, 5 runs (#6184); no statement grows with the rows (#6819). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { forkRelation } from "../src/core/following.ts";
import { deferredOf, repoGraph } from "../src/core/dependencies.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";
import { quiet } from "./helpers/statements.ts";

quietLogs();

/**
 * The live shape of trevato/forge: 20 pillar umbrellas among the 300 open
 * issues, 2,000 closed (a quarter of them landed pulls), and 3,500 edges.
 */
function seedLive(db: App["db"], repoId: string, author: string, from: number): void {
  const open = (i: number) => `${repoId}i${i}`;
  let n = 10_000 + from;
  for (let k = 0; k < 20; k++)
    db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
       VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, 'open')`,
    ).run(`${repoId}u${k}`, repoId, ++n, `P${k} Pillar ${k}: umbrella`, author);
  db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
     VALUES (?1, ?2, ?3, 'issue', 'Later gate: parked', '', ?4, 'open')`,
  ).run(`${repoId}gate`, repoId, ++n, author);
  const closed: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const id = `${repoId}c${i}`;
    closed.push(id);
    const pull = i % 4 === 0;
    db.query(
      `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
       VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, 'closed')`,
    ).run(id, repoId, ++n, pull ? "pull" : "issue", `Done ${i}`, author);
    if (pull)
      db.query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, 'main', ?2, 'x', 'y', ?3)`,
      ).run(id, `c${i}`, new Date(Date.now() - i * 3_600_000).toISOString());
  }
  const edges = new Set<string>();
  const add = (a: string, b: string) => {
    if (a === b || edges.has(`${a}>${b}`)) return;
    edges.add(`${a}>${b}`);
    db.query(`INSERT INTO issue_dependency (issue_id, blocked_by_id, actor_id) VALUES (?1, ?2, ?3)`).run(a, b, author);
  };
  for (let i = 0; i < 280; i++) add(`${repoId}u${i % 20}`, open(i));
  for (let i = 0; i < 30; i++) add(open(i), `${repoId}gate`);
  for (let i = 1; edges.size < 3500; i++)
    add(closed[i % 2000]!, closed[(i * 7 + 1 + Math.floor(i / 2000)) % 2000]!);
}

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
const PAGES = ["/alice/vault", "/alice/vault-fork"];
/** Statements a page cost with few rows. */
const small: Record<string, number> = {};
/** Every statement of the home, by text, after each seed step. */
let fewStatements = new Map<string, number>();
let manyStatements = new Map<string, number>();

/** SQL statements one signed-in GET prepares: load-independent, unlike its milliseconds. */
async function queriesFor(path: string): Promise<number> {
  const db = app.db as unknown as { query: (sql: string) => unknown };
  const real = db.query;
  let n = 0;
  db.query = function (this: unknown, sql: string) {
    n++;
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
/**
 * Background work (timers, following, run loops) can prepare statements on the same db
 * while a page is read, and only ever adds to the count; the fewest of several reads is the page's own cost.
 */
async function costOf(path: string): Promise<number> {
  let least = Infinity;
  for (let i = 0; i < 7; i++) {
    await quiet(app.db); // start from rest, not in the tail of the last request's work
    least = Math.min(least, await queriesFor(path));
  }
  return least;
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
  // Git may be slow on a loaded machine; the wait is for a verdict, not a clock.
  let diverged = false;
  for (let i = 0; i < 1000 && !diverged; i++) {
    diverged = (await forkRelation(app, forked.value))?.state === "diverged";
    if (!diverged) await new Promise((r) => setTimeout(r, 30));
  }
  if (!diverged) throw new Error("the fork never read diverged");
  const db = app.db;
  const agent = db.query<{ id: string }, []>("SELECT id FROM user WHERE kind = 'agent' LIMIT 1").get();
  const assignee = agent?.id ?? u.value.id;
  const repoIds = [made.value.id, forked.value.id];
  // A public repository the viewer does not follow: work assigned to them there
  // needs a real read per repository, not per row (the `canRead` memo in asks.ts).
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  const elsewhere = await createRepo(app, { id: bob.value.id, username: "bob" } as never, { name: "elsewhere" });
  if (!elsewhere.ok) throw new Error(String(elsewhere.error));
  const seedElsewhere = (from: number, to: number) =>
    db.transaction(() => {
      for (let i = from; i < to; i++)
        db.query(
          `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, assignee_id, state)
           VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, ?6, 'open')`,
        ).run(`${elsewhere.value.id}i${i}`, elsewhere.value.id, 1 + i, `Away ${i}`, bob.value.id, u.value.id);
    })();
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
  seedElsewhere(0, 2);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  for (const path of PAGES) {
    small[path] = await costOf(path);
  }
  fewStatements = await statementsByText(PAGES[0]!);
  seed([10, 200], [2, 40], [1, 5]);
  seedElsewhere(2, 30);
  manyStatements = await statementsByText(PAGES[0]!);
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
  expect(Math.abs((await costOf(path)) - small[path]!)).toBeLessThanOrEqual(SLACK);
});

test("following stays cheap on a diverged fork (regression guard; this pull does not change it)", async () => {
  const path = "/alice/vault-fork";
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(res.headers.get("server-timing") ?? "").toContain("following");
  expect(Math.abs((await costOf(path)) - small[path]!)).toBeLessThanOrEqual(SLACK);
});

test("now costs the same statements on the live shape: 300 open issues, 2,000 closed, 3,500 edges, 20 pillars", async () => {
  const repo = getRepo(app.db, "alice", "vault")!;
  const author = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
  app.db.transaction(() => {
    for (let i = 200; i < 280; i++)
      app.db.query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
         VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, 'open')`,
      ).run(`${repo.id}i${i}`, repo.id, 5000 + i, `Tell ${i}`, author);
    seedLive(app.db, repo.id, author, 0);
  })();
  // Counted, not timed: 2,000 closed issues and 3,500 edges cost four statements more than the small page
  // (measured), not one per row; a per-row read would add thousands.
  expect(Math.abs((await costOf("/alice/vault")) - small["/alice/vault"]!)).toBeLessThanOrEqual(4);
});

test("the lean deferred read says what the whole graph says, and something is deferred", () => {
  const repo = getRepo(app.db, "alice", "vault")!;
  const whole = repoGraph(app.db, repo.id).deferred;
  expect(whole.size).toBeGreaterThan(0);
  expect([...deferredOf(app.db, repo)].sort()).toEqual([...whole].sort());
});

/** Every statement the page runs, by its text, with how many times. */
async function statementsByText(path: string): Promise<Map<string, number>> {
  const door = app.db as unknown as { query: (sql: string) => unknown };
  const original = app.db.query.bind(app.db);
  let best: Map<string, number> | undefined;
  for (let run = 0; run < 5; run++) {
    await quiet(app.db);
    const seen = new Map<string, number>();
    door.query = (sql: string) => {
      const key = sql.replace(/IN \((\?\d*,?)+\)/g, "IN (?…)").replace(/\s+/g, " ");
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return original(sql);
    };
    try {
      const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      door.query = original;
    }
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    if (best === undefined || total(seen) < total(best)) best = seen;
  }
  return best!;
}

test("every statement the home runs costs the same with 200 issues, 40 pulls and 5 runs as with a few", () => {
  const grown: string[] = [];
  for (const [sql, n] of manyStatements)
    if (n !== (fewStatements.get(sql) ?? 0)) grown.push(`${fewStatements.get(sql) ?? 0} -> ${n}: ${sql}`);
  expect(grown).toEqual([]);
});
