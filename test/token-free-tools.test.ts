/** What needs no token over /mcp is one list; the card and `here` print it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { TOKEN_FREE_TOOLS } from "../src/core/mcp_card.ts";
import { REPORT_TOOL, toolNames } from "../src/http/mcp.ts";

describe("token-free MCP tools", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-token-free-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = (name: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { repo: "nobody/none", title: "x" } },
      }),
    });

  test("every tool on the list answers without a token, and the gate lets in only those", async () => {
    expect(TOKEN_FREE_TOOLS).toContain(REPORT_TOOL.name);
    for (const name of TOKEN_FREE_TOOLS) {
      expect((await call(name)).status).not.toBe(401);
    }
    for (const name of toolNames().filter((n) => !TOKEN_FREE_TOOLS.includes(n))) {
      expect((await call(name)).status).toBe(401);
    }
  });

  test("the card and `here` print exactly that list", async () => {
    const card = (await (await fetch(`${base}/.well-known/mcp.json`)).json()) as any;
    expect(card.tokenFreeTools).toEqual([...TOKEN_FREE_TOOLS]);
    const here = (await (await fetch(`${base}/api/v1/here`)).json()) as any;
    const open = here.actions
      .filter((a: any) => a.mcp !== undefined && a.account === false)
      .map((a: any) => a.mcp);
    expect(open.sort()).toEqual([...TOKEN_FREE_TOOLS].sort());
  });
});
