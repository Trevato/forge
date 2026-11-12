/** MCP `scorecard` carries each member's week {merged, returned, cost}: the numbers /crew shows (#10905). */
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
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { cardFor } from "../src/web/studio/cards.ts";

quietLogs();
let dir: string, app: App, servers: Servers, token: string, cookie: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-scorecard-week-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
  if (!ada.ok) throw new Error(ada.error);
  const repo = await createRepo(app, ada.value, { name: "hello", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const bot = async (username: string) => {
    const b = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
    if (!b.ok) throw new Error(String(b.error));
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(b.value.id);
    createAgentRow(app.db, { userId: b.value.id, model: "opus" });
    return b.value;
  };
  const rev = await bot("rev");
  const smith = await bot("smith");
  const at = new Date(Date.now() - 86_400_000).toISOString();
  for (const merged of [true, false]) {
    const i = createIssue(app.db, { repoId: repo.value.id, authorId: smith.id, title: "p", kind: "pull" });
    if (!i.ok) throw new Error(String(i.error));
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1,'main','h','a','b',?2)`).run(i.value.id, merged ? at : null);
    if (!merged)
      app.db.query(`INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1,?2,?3,'changes_requested',?4)`).run(crypto.randomUUID(), i.value.id, rev.id, at);
  }
  const run = crypto.randomUUID();
  app.db.query(`INSERT INTO run (id, repo_id, kind, actor_id, state) VALUES (?1,?2,'agent',?3,'ok')`).run(run, repo.value.id, smith.id);
  app.db.query(`INSERT INTO usage (run_id, repo_id, agent_id, subscription_id, kind, cost_usd, outcome, at) VALUES (?1,?2,?3,'platform','build',1.25,'ok',?4)`).run(run, repo.value.id, smith.id, at);
  token = createToken(app.db, ada.value.id, "t", "admin").token;
  cookie = `forge_session=${createSession(app.db, ada.value.id).token}`;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("MCP scorecard, the card and the /crew page agree on merged, returned and cost", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scorecard", arguments: {} } }),
  }).then((r) => r.json() as Promise<any>);
  const card = JSON.parse(res.result.content[0].text);
  expect(card.agents.find((a: any) => a.username === "smith").week).toEqual({ merged: 1, returned: 1, cost: 1.25 });
  expect(card.agents.find((a: any) => a.username === "rev").week).toEqual({ merged: 0, returned: 0, cost: 0 });
  const page = await (await fetch(`${servers.url}/settings/crew`, { headers: { cookie } })).text();
  const t = page.slice(page.indexOf('id="crew-week"'));
  const row = t.slice(t.indexOf("smith"), t.indexOf("</tr>", t.indexOf("smith")));
  const cells = [...row.matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "").trim());
  expect(cells[0]).toBe("1");
  expect(cells[1]).toMatch(/^1\b/);
  expect(cells[2]).toBe("$1.25");
  expect(JSON.stringify(cardFor("scorecard", card))).toContain("1 merged · 1 returned · $1.25 this week");
});
