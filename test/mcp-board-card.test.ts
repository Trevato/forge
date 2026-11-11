/** MCP `boards` with a `slug` draws the `ui://forge/board` card: the page's numbers, escaped, at most 8 panels. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { writeBoard, showBoard } from "../src/actions/boards.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { drawPanel } from "../src/web/pages/boards-view.ts";
import { CARD_OF_TOOL, cardFor } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const panel = (title: string, aggregate = "count") => ({ title, chart: "number", query: { source: "runs", aggregate }, w: 1, h: 1 });

describe("MCP boards card", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";

  const call = async (args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boards", arguments: args } }),
    });
    return ((await res.json()) as any).result;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-board-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("users");
    token = createToken(app.db, a.value.id, "admin", "admin").token;
    // Runs in a public repository and in a private one: the page reads both for an admin, so the card must too.
    for (const [name, visibility] of [["open", "public"], ["closed", "private"]] as const) {
      const repo = await createRepo(app, a.value, { name, visibility });
      if (!repo.ok) throw new Error(name);
      const issue = createIssue(app.db, { repoId: repo.value.id, authorId: a.value.id, title: "t" });
      if (!issue.ok) throw new Error("issue");
      app.db.query(`INSERT INTO run (id, repo_id, issue_id, kind, actor_id, state) VALUES (?1, ?2, ?3, 'check', ?4, 'ok')`)
        .run(crypto.randomUUID(), repo.value.id, issue.value.id, a.value.id);
    }
    const made = await writeBoard(app, getUserByName(app.db, "alice"), "fixture", {
      title: "Fixture", range: "all", refresh: "off",
      panels: [panel("Runs"), panel("<script>alert(1)</script>")],
    });
    if (!made.ok) throw new Error(`board ${JSON.stringify(made.error)}`);
    const many = await writeBoard(app, getUserByName(app.db, "alice"), "many", {
      title: "Many", range: "all", refresh: "off", panels: Array.from({ length: 11 }, (_, i) => panel(`P${i}`)),
    });
    if (!many.ok) throw new Error("many");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the boards tool draws the board card", () => {
    expect(CARD_OF_TOOL["boards"]).toBe("board");
  });

  test("its numbers are the page's, private repositories' rows included as the page includes them", async () => {
    const result = await call({ slug: "fixture" });
    const card = result.structuredContent.card;
    expect(card.kind).toBe("board");
    expect(card.title).toBe("Fixture");
    const shown = await showBoard(app, getUserByName(app.db, "alice"), "fixture");
    if (!shown.ok) throw new Error("show");
    shown.value.panels.forEach((p, i) => {
      const page = drawPanel(app, shown.value, p, { slug: "fixture", index: i }).text;
      expect(page).toContain(`>${card.rows[i].value}</text>`);
    });
    // Two runs, one in a private repository: the page counts both, so does the card.
    expect(card.rows[0]).toEqual({ label: "Runs", value: "2" });
  });

  test("a panel title with <script> stays text in the model and escaped on the page", async () => {
    const card = (await call({ slug: "fixture" })).structuredContent.card;
    expect(card.rows[1].label).toBe("<script>alert(1)</script>");
    const shown = await showBoard(app, getUserByName(app.db, "alice"), "fixture");
    if (!shown.ok) throw new Error("show");
    expect(drawPanel(app, shown.value, shown.value.panels[1]!, { slug: "fixture", index: 1 }).text).not.toContain("<script>alert");
  });

  test("at most 8 panels, then how many more", async () => {
    const card = (await call({ slug: "many" })).structuredContent.card;
    expect(card.rows).toHaveLength(9);
    expect(card.rows[8]).toEqual({ label: "More", value: "3 more" });
  });

  test("the list and a panel's data have no card", async () => {
    expect((await call({})).structuredContent).toBeUndefined();
    expect((await call({ slug: "fixture", panel: 0 })).structuredContent).toBeUndefined();
    expect(cardFor("boards", { boards: [] })).toBeUndefined();
  });
});
