/**
 * The crew's week (#10722): one line per member — merged, returned, spend —
 * on the crew page, GET /api/v1/crew/week and MCP `crew` { kind: "week" }.
 * Two members with different histories; the rows, the word "idle" and the
 * MCP answer must agree.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { weekCard } from "../src/crew/week_card.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { statements } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let token: string;
let cookie: string;
let repoId: string;
let reviewer: User;

const bot = async (username: string): Promise<User> => {
  const b = await createUser(app.db, {
    origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase",
  });
  if (!b.ok) throw new Error(String(b.error));
  app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(b.value.id);
  createAgentRow(app.db, { userId: b.value.id, model: "opus" });
  return b.value;
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** A pull by `author`, merged `mergedDaysAgo` days ago, returned once at `returnedDaysAgo`. */
function pull(author: User, mergedDaysAgo: number, returnedDaysAgo?: number) {
  const issue = createIssue(app.db, { repoId, authorId: author.id, title: "p", kind: "pull" });
  if (!issue.ok) throw new Error(String(issue.error));
  app.db
    .query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
       VALUES (?1, 'main', 'h', 'a', 'b', ?2)`,
    )
    .run(issue.value.id, daysAgo(mergedDaysAgo));
  if (returnedDaysAgo !== undefined)
    app.db
      .query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'changes_requested', ?4)`)
      .run(crypto.randomUUID(), issue.value.id, reviewer.id, daysAgo(returnedDaysAgo));
}

function spend(agent: User, usd: number, ago: number) {
  const run = crypto.randomUUID();
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, actor_id, state) VALUES (?1, ?2, 'agent', ?3, 'ok')`)
    .run(run, repoId, agent.id);
  app.db
    .query(
      `INSERT INTO usage (run_id, repo_id, agent_id, subscription_id, kind, cost_usd, outcome, at)
       VALUES (?1, ?2, ?3, 'platform', 'build', ?4, 'ok', ?5)`,
    )
    .run(run, repoId, agent.id, usd, daysAgo(ago));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-crew-week-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
  if (!ada.ok) throw new Error(ada.error);
  const repo = await createRepo(app, ada.value, { name: "hello", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
  reviewer = await bot("rev");
  const smith = await bot("smith");
  await bot("quiet");
  const old = await bot("oldtimer");
  pull(smith, 1, 2);
  pull(smith, 3);
  pull(smith, 20, 20); // outside the week
  spend(smith, 1.25, 1);
  spend(smith, 0.5, 40); // outside the week
  pull(old, 30, 30);
  spend(old, 9, 30);
  token = createToken(app.db, ada.value.id, "t", "ro").token;
  cookie = `forge_session=${createSession(app.db, ada.value.id).token}`;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the week counts only the last 7 days, and no activity is idle", () => {
  const lines = weekCard(app.db);
  expect(lines).toEqual([
    { username: "oldtimer", merged: 0, returned: 0, spentUsd: 0, idle: true },
    { username: "quiet", merged: 0, returned: 0, spentUsd: 0, idle: true },
    { username: "rev", merged: 0, returned: 0, spentUsd: 0, idle: true },
    { username: "smith", merged: 2, returned: 1, spentUsd: 1.25, idle: false },
  ]);
});

test("the crew page: a dense row for the busy one, the word idle for the rest", async () => {
  const res = await fetch(`${servers.url}/settings/crew`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const page = await res.text();
  const table = page.slice(page.indexOf('id="crew-week"'), page.indexOf("</table>", page.indexOf('id="crew-week"')));
  const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g)!.slice(1);
  expect(rows).toHaveLength(4);
  expect(rows[3]).toMatch(/smith[\s\S]*>2<[\s\S]*>1<[\s\S]*\$1\.25/);
  expect(rows[3]).not.toContain("idle");
  expect(rows[2]).toContain("idle");
  expect(rows[2]).not.toContain("$0");
  expect(rows[1]).toContain("idle");
});

test("the API and the MCP crew tool answer the same numbers", async () => {
  const api = await fetch(`${servers.url}/api/v1/crew/week`, { headers: { authorization: `Bearer ${token}` } });
  expect(api.status).toBe(200);
  const body = (await api.json()) as { days: number; members: any[] };
  expect(body.days).toBe(7);
  expect(body.members).toEqual(weekCard(app.db));
  const rpc = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crew", arguments: { kind: "week" } } }),
  }).then((r) => r.json() as Promise<any>);
  expect(JSON.parse(rpc.result.content[0].text)).toEqual(body);
  expect((await fetch(`${servers.url}/api/v1/crew/week`)).status).toBe(401);
});

test("20 members cost a fixed few statements, not one per member", async () => {
  for (let i = 0; i < 16; i++) app.db.query("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES (?1, ?2, ?3, '', 1)").run(crypto.randomUUID(), `bulk${i}`, `bulk${i}@x.test`);
  const n = await statements(app.db, () => {
    expect(weekCard(app.db).length).toBe(20);
  });
  expectWork(n, { max: 6 });
});

test("a change request by the pull's own author is not a return", () => {
  const smith = app.db.query<{ id: string }, []>(`SELECT id FROM user WHERE username = 'smith'`).get()!;
  const issue = app.db.query<{ id: string }, [string]>(`SELECT issue_id AS id FROM pull JOIN issue ON issue.id = pull.issue_id WHERE issue.author_id = ?1 LIMIT 1`).get(smith.id)!;
  const before = weekCard(app.db).find((l) => l.username === "smith")!.returned;
  app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, 'changes_requested', ?4)`).run(crypto.randomUUID(), issue.id, smith.id, daysAgo(1));
  expect(weekCard(app.db).find((l) => l.username === "smith")!.returned).toBe(before);
});

test("a non-admin: the page is not found and has no week block, the API and MCP refuse", async () => {
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "pat", email: "pat@forge.local", password: "a-good-passphrase" });
  if (!u.ok) throw new Error(String(u.error));
  const pc = `forge_session=${createSession(app.db, u.value.id).token}`;
  const page = await fetch(`${servers.url}/settings/crew`, { headers: { cookie: pc } });
  expect(page.status).toBe(404);
  expect(await page.text()).not.toContain("crew-week");
  const pt = createToken(app.db, u.value.id, "t", "ro").token;
  const api = await fetch(`${servers.url}/api/v1/crew/week`, { headers: { authorization: `Bearer ${pt}` } });
  expect(api.status).toBe(403);
  const rpc = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${pt}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crew", arguments: { kind: "week" } } }),
  }).then((r) => r.json() as Promise<any>);
  expect(JSON.stringify(rpc)).toContain("forbidden");
  expect(JSON.stringify(rpc)).not.toContain("spentUsd");
});

test("the terminal rows say idle, and show the figures for the busy", async () => {
  const { weekRows } = await import("../src/tui/screens/weekcard.ts");
  const rows = weekRows(weekCard(app.db));
  expect(rows.find((r) => r.title === "quiet")!.secondary).toBe("idle");
  expect(rows.find((r) => r.title === "smith")!.secondary).toContain("spent $1.25");
});

test("the crew page costs a bounded number of statements", async () => {
  const n = await statements(app.db, async () => {
    await (await fetch(`${servers.url}/settings/crew`, { headers: { cookie } })).text();
  });
  expectWork(n, { max: 150 });
});
