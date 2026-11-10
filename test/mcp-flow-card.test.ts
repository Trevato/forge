/** MCP `flow` (no arguments) and `scorecard` draw the `ui://forge/flow` and `ui://forge/crew` cards. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { STAGE_LABEL } from "../src/flow/pipeline.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listVia } from "./mcp-list.ts";

quietLogs();

describe("MCP flow and crew cards", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token = "";
  let id = 1;

  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-flow-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("users");
    token = createToken(app.db, a.value.id, "admin", "admin").token;
    // One agent with a landed pull and one red check, for the crew card.
    const bot = await createUser(app.db, { origin: "seed", trusted: true,
      username: "smith", email: "smith@forge.local", password: "a-good-passphrase" });
    if (!bot.ok) throw new Error("bot");
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(bot.value.id);
    createAgentRow(app.db, { userId: bot.value.id, model: "opus" });
    const repo = await createRepo(app, a.value, { name: "hello", visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    const issue = createIssue(app.db, { repoId: repo.value.id, authorId: bot.value.id, title: "a pull", kind: "pull" });
    if (!issue.ok) throw new Error("issue");
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
      VALUES (?1, 'main', 'h', 'a', 'b', ?2)`).run(issue.value.id, new Date().toISOString());
    app.db.query(`INSERT INTO run (id, repo_id, issue_id, kind, actor_id, state) VALUES (?1, ?2, ?3, 'check', ?4, 'failed')`)
      .run(crypto.randomUUID(), repo.value.id, issue.value.id, bot.value.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("tools/list advertises both resources and both resources read", async () => {
    const tools: any[] = (await listVia((p) => rpc("tools/list", p))).result.tools;
    for (const [name, kind] of [["flow", "flow"], ["scorecard", "crew"]] as const) {
      expect(tools.find((t) => t.name === name)._meta.ui.resourceUri).toBe(`ui://forge/${kind}`);
      const read = await rpc("resources/read", { uri: `ui://forge/${kind}` });
      expect(read.result.contents[0].text.length).toBeGreaterThan(0);
    }
  });

  test("flow with no arguments carries a card, one row per stage, beside the text", async () => {
    const body = await rpc("tools/call", { name: "flow", arguments: {} });
    const text = JSON.parse(body.result.content[0].text);
    const card = body.result.structuredContent.card;
    expect(card.kind).toBe("flow");
    expect(card.title).toBe("Flow");
    expect(card.rows.map((r: any) => r.label)).toEqual(text.stages.map((s: any) => (STAGE_LABEL as Record<string, string>)[s.key]));
    expect(card.status).toBe(text.says);
  });

  test("a fleet query or a why answer stays plain", async () => {
    const body = await rpc("tools/call", { name: "flow", arguments: { q: "repo" } });
    expect(body.result.structuredContent?.card).toBeUndefined();
    expect(cardFor("flow", { subject: "a/b", moving: true })).toBeUndefined();
  });

  test("the flow card names the bottleneck and the oldest wait", () => {
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const card = cardFor("flow", { stages: [
      { key: "ready", waiting: 2, active: 0, oldestWaiting: new Date(Date.now() - 60_000).toISOString(), capacity: null },
      { key: "review", waiting: 4, active: 1, oldestWaiting: old, capacity: null },
      { key: "live", waiting: 0, active: 3, oldestWaiting: null, capacity: null },
    ] })!;
    expect(card.status).toContain("Review is the bottleneck");
    expect(card.rows).toHaveLength(3);
    expect(card.rows[1]!.value).toBe("4 waiting · 1 active · oldest 3h");
    expect(card.rows[2]!.value).toBe("0 waiting · 3 active");
  });

  test("scorecard carries the crew card, one row per agent, status the week's landed", async () => {
    const body = await rpc("tools/call", { name: "scorecard", arguments: {} });
    const drawn = body.result.structuredContent.card;
    expect(drawn.kind).toBe("crew");
    expect(drawn.rows).toEqual([{ label: "smith", value: "1 landed this month · 100% red" }]);
    const card = cardFor("scorecard", {
      agents: [
        { username: "scout", all: null, recent: { landed: 5, redCheckRate: 0.25 } },
        { username: "<b>x</b>", all: null, recent: null },
      ],
      keeperDays: [{ landed: 2 }, { landed: 3 }],
    })!;
    expect(card.status).toBe("5 landed this week");
    expect(card.rows).toEqual([
      { label: "scout", value: "5 landed this month · 25% red" },
      { label: "<b>x</b>", value: "0 landed this month · no checks" },
    ]);
  });

  test("agents past the card's limit are counted, not dropped", () => {
    const many = cardFor("scorecard", { agents: Array.from({ length: 15 }, (_, i) => ({ username: `a${i}`, all: null, recent: null })), keeperDays: [] })!;
    expect(many.rows).toHaveLength(13);
    expect(many.rows[12]).toEqual({ label: "More", value: "+3 more" });
  });
});
