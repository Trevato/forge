/** MCP `archive` draws the `ui://forge/app` card: what was put away, and the one action that wakes it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { toolEntries } from "../src/http/mcp.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { CARD_OF_TOOL, CARD_URI } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP archive card", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";

  const call = async (args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "archive", arguments: args } }),
    });
    return ((await res.json()) as any).result;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-archive-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!r.ok) throw new Error("user");
    token = createToken(app.db, r.value.id, "admin", "admin").token;
    for (const name of ["one", "two"]) {
      const repo = await createRepo(app, r.value, { name, visibility: "public" });
      if (!repo.ok) throw new Error("repo");
    }
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the tool is listed under the app card's resource", () => {
    expect(CARD_OF_TOOL["archive"]).toBe("app");
    const entry = toolEntries(TOOLS).find((t: any) => t.name === "archive") as any;
    expect(entry._meta.ui.resourceUri).toBe(CARD_URI("app"));
  });

  test("a single repository: plan, archive, then wake", async () => {
    const plan = (await call({ repo: "alice/one", archived: true })).structuredContent.card;
    expect(plan.kind).toBe("app");
    expect(plan.status).toContain("would archive");
    expect(plan.actions[0].args).toEqual({ repo: "alice/one", archived: true, dryRun: false });

    const done = (await call({ repo: "alice/one", archived: true, dryRun: false })).structuredContent.card;
    expect(done.status).toBe("archived");
    expect(done.rows.map((r: any) => r.label)).toEqual(["App", "Archived"]);
    expect(getRepo(app.db, "alice", "one")!.archivedAt).not.toBeNull();
    expect(done.actions).toEqual([{ label: "Wake it", tool: "archive", args: { repo: "alice/one", archived: false, dryRun: false } }]);

    const asked = (await call({ repo: "alice/one" })).structuredContent.card;
    expect(asked.status).toBe("archived");
    expect(asked.actions[0].label).toBe("Wake it");

    const woke = (await call({ repo: "alice/one", archived: false, dryRun: false })).structuredContent.card;
    expect(woke.status).toBe("awake");
    expect(woke.actions).toEqual([]);
  });

  test("repos: one card, one row per repository", async () => {
    const plan = (await call({ repos: ["alice/one", "alice/two", "alice/none"] })).structuredContent.card;
    expect(plan.kind).toBe("app");
    expect(plan.rows.map((r: any) => r.label)).toEqual(["alice/one", "alice/two", "alice/none"]);
    expect(plan.status).toContain("nothing changed");
    // The button applies what the plan said would happen, not the refused name.
    expect(plan.actions[0].args.repos).toEqual(["alice/one", "alice/two"]);
    const done = (await call({ repos: ["alice/one", "alice/two"], dryRun: false })).structuredContent.card;
    expect(done.rows.length).toBe(2);
    expect(done.actions[0].tool).toBe("limb");
    expect(done.actions[0].args.action).toBe("undo");
  });
});
