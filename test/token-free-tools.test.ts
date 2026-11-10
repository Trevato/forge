/** What needs no token over /mcp is one list; the card and `here` print it. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { TOKEN_FREE_TOOLS } from "../src/core/mcp_card.ts";
import { REPORT_TOOL, TOKEN_FREE_HANDLERS, toolNames } from "../src/http/mcp.ts";

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
    const open = here.can
      .filter((a: any) => a.mcp !== undefined && a.account === false)
      .map((a: any) => a.mcp);
    expect(open.sort()).toEqual([...TOKEN_FREE_TOOLS].sort());
  });

  test("every MCP tool /llms.txt offers without an account answers without a token", async () => {
    const text = await (await fetch(`${base}/llms.txt`)).text();
    // The sections a caller with no account reads: "(no account)" ones and "any page".
    const sections = text
      .split(/^## /m)
      .filter((s) => /^[^\n]*(\(no account\)|any page)/.test(s));
    expect(sections.length).toBeGreaterThanOrEqual(3);
    const free: string[] = [];
    const gated: string[] = [];
    for (const line of sections.flatMap((s) => s.split("\n"))) {
      for (const m of line.matchAll(/(?:the tool|name|MCP) "([a-z_]+)"/g)) {
        (/with an account|needs a token/.test(line) ? gated : free).push(m[1]!);
      }
    }
    expect(free).toContain(REPORT_TOOL.name);
    expect(gated.sort()).toEqual(["explore", "here", "search"]);
    for (const name of free) {
      expect({ name, status: (await call(name)).status }).not.toEqual({ name, status: 401 });
    }
    // The gate itself is unchanged: the ones marked as needing an account still answer 401.
    for (const name of gated) {
      expect((await call(name)).status).toBe(401);
    }
  });
});

test("the gate's handlers and the token-free list have the same names", () => {
  expect(Object.keys(TOKEN_FREE_HANDLERS).sort()).toEqual([...TOKEN_FREE_TOOLS].sort());
});
