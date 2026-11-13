/**
 * The MCP Apps cards stay true: every tool a card names is a tool `tools/list`
 * answers, and every card kind is a `ui://forge/<kind>` resource that lists and
 * reads. The lists come from the module and the live answers, never a copy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CARD_KINDS, CARD_OF_TOOL } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listVia } from "./mcp-list.ts";

quietLogs();

describe("MCP cards coverage", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token = "";
  let id = 1;

  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-cards-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("users");
    token = createToken(app.db, a.value.id, "admin", "admin").token;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every tool a card names is in tools/list", async () => {
    const names = new Set<string>((await listVia((p) => rpc("tools/list", p))).result.tools.map((t: any) => t.name));
    const missing = Object.keys(CARD_OF_TOOL).filter((t) => !names.has(t));
    expect(missing).toEqual([]);
  });

  test("forks and explore point tools/list at their cards", async () => {
    const tools = (await listVia((p) => rpc("tools/list", p))).result.tools;
    const uri = (name: string) => tools.find((t: any) => t.name === name)?._meta?.ui?.resourceUri;
    expect(uri("forks")).toBe("ui://forge/forks");
    expect(uri("explore")).toBe("ui://forge/explore");
    expect(uri("feed")).toBe("ui://forge/feed");
    // ChatGPT reads the same template through its compatibility alias.
    for (const t of tools.filter((t: any) => t._meta?.ui?.resourceUri !== undefined)) expect(t._meta["openai/outputTemplate"]).toBe(t._meta.ui.resourceUri);
  });

  test("every card a tool names is a card kind", () => {
    const kinds: readonly string[] = CARD_KINDS;
    const unknown = Object.values(CARD_OF_TOOL).filter((k) => !kinds.includes(k));
    expect(unknown).toEqual([]);
  });

  test("every card kind is listed as ui://forge/<kind> and reads", async () => {
    const listed = new Set<string>((await rpc("resources/list")).result.resources.map((r: any) => r.uri));
    for (const kind of CARD_KINDS) {
      const uri = `ui://forge/${kind}`;
      expect(listed.has(uri)).toBe(true);
      const read = await rpc("resources/read", { uri });
      expect(read.error).toBeUndefined();
      expect(read.result.contents[0].uri).toBe(uri);
      expect(read.result.contents[0].text.length).toBeGreaterThan(0);
      // MCP Apps (Claude) and the Apps SDK (ChatGPT) read one document: `text/html;profile=mcp-app`, no network, no border added.
      expect(read.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
      expect(read.result.contents[0]._meta.ui).toEqual({ prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } });
    }
  });
});
