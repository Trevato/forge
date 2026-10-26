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
import { baselineMs, expectBudget } from "./helpers/budget.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

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
  db.transaction(() => {
    for (const repoId of [made.value.id, forked.value.id]) {
      let n = 0;
      for (let i = 0; i < 200; i++) {
        db.query(
          `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, assignee_id, state)
           VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, ?6, 'open')`,
        ).run(`${repoId}i${i}`, repoId, ++n, `Tell ${i}`, u.value.id, i % 2 === 0 ? assignee : null);
      }
      for (let i = 0; i < 40; i++) {
        db.query(
          `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
           VALUES (?1, ?2, ?3, 'pull', ?4, ?5, ?6, 'open')`,
        ).run(`${repoId}p${i}`, repoId, ++n, `Pull ${i}`, `Closes #${i + 1}`, u.value.id);
        db.query(
          `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
           VALUES (?1, 'main', ?2, 'x', 'y')`,
        ).run(`${repoId}p${i}`, `b${i}`);
      }
      for (let i = 0; i < 5; i++)
        db.query(
          `INSERT INTO run (id, repo_id, kind, state, issue_id) VALUES (?1, ?2, 'agent', 'running', ?3)`,
        ).run(`${repoId}r${i}`, repoId, `${repoId}i${i * 2 + 1}`);
    }
  })();
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function phases(path: string): Promise<Record<string, number>> {
  const best: Record<string, number> = {};
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    if (path.endsWith("-fork")) expect(body.replace(/\s+/g, " ")).toContain("needs a decision");
    for (const part of (res.headers.get("server-timing") ?? "").split(", ")) {
      const m = /^([a-z]+);dur=([\d.]+)/.exec(part);
      if (m) best[m[1]!] = Math.min(best[m[1]!] ?? Infinity, Number(m[2]));
    }
  }
  return best;
}

test("now reads its rows in batches with 200 open issues, 40 open pulls and 5 active runs", async () => {
  const against = await baselineMs(servers.url);
  const best = await phases("/alice/vault");
  expectBudget(best.now!, { ms: 5, against });
});

test("following stays cheap on a diverged fork (regression guard; this pull does not change it)", async () => {
  const against = await baselineMs(servers.url);
  const best = await phases("/alice/vault-fork");
  expect(best.following).toBeDefined();
  expectBudget(best.following!, { ms: 5, against });
  expectBudget(best.now!, { ms: 5, against });
});
