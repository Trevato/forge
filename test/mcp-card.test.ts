/** The MCP server card at /.well-known/mcp.json agrees with the live routes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mcpCard } from "../src/core/mcp_card.ts";
import { running } from "../src/kernel/version.ts";

describe("the MCP server card", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("/llms.txt carries the cards line, counted from the card the server serves", async () => {
    const card = (await (await fetch(`${base}/.well-known/mcp.json`)).json()) as any;
    const text = await (await fetch(`${base}/llms.txt`)).text();
    expect(text).toContain("_meta.ui.resourceUri");
    expect(text).toContain(`(${card.cards.length} cards;`);
  });

  test("names the server, endpoint, sign-in and the tokenless tool, each true", async () => {
    const res = await fetch(`${base}/.well-known/mcp.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const card = (await res.json()) as any;
    expect(card.name).toBe("forge");
    expect(card.version).toBe(running().version);
    expect(card.transport).toBe("streamable-http");
    expect(card.endpoint).toBe(`${base}/mcp`);
    expect(card.tokenFreeTools).toEqual(["report", "start"]);

    // Without a token the endpoint refuses everything but `report`.
    const report = await fetch(card.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report", arguments: { repo: "nobody/none", title: "x" } } }),
    });
    expect(report.status).not.toBe(401);
    const other = await fetch(card.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "here", arguments: {} } }),
    });
    expect(other.status).toBe(401);

    // The protected-resource metadata is live and names this endpoint.
    const prm = await fetch(card.protectedResourceMetadata);
    expect(prm.status).toBe(200);
    expect(((await prm.json()) as any).resource).toBe(card.endpoint);

    // The OpenAPI description is named and live.
    expect(card.openapi).toBe(`${base}/contract/openapi.json`);
    const spec = await fetch(card.openapi);
    expect(spec.status).toBe(200);
    expect(spec.headers.get("content-type")).toContain("application/json");

    // The documentation link is live.
    expect((await fetch(card.documentation)).status).toBe(200);
  });

  test("carries the commit it runs, or null when nothing says", () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    expect(mcpCard("https://x", "trevato/forge", running({ FORGE_APP_COMMIT: sha })).commit).toBe(sha);
    expect(mcpCard("https://x", "trevato/forge", running({})).commit).toBeNull();
  });

  test("the live card's commit is what running() says", async () => {
    const card = (await (await fetch(`${base}/.well-known/mcp.json`)).json()) as any;
    expect(card.commit).toBe(running().commit);
  });

  test("the `mcp` block of /api/v1/here gives the same url and oauth", async () => {
    const card = (await (await fetch(`${base}/.well-known/mcp.json`)).json()) as any;
    const here = (await (await fetch(`${base}/api/v1/here?path=/`)).json()) as any;
    expect(here.mcp).toEqual({ url: card.endpoint, oauth: card.protectedResourceMetadata });
  });

  test("/llms.txt links the card", async () => {
    const txt = await (await fetch(`${base}/llms.txt`)).text();
    expect(txt).toContain(`${base}/.well-known/mcp.json`);
  });
});

describe("the cards the server card names", () => {
  test("every tool in CARD_OF_TOOL is listed under its card's resource", async () => {
    const { CARD_OF_TOOL, CARD_URI } = await import("../src/web/studio/cards.ts");
    const card = mcpCard("https://x", undefined, running({}));
    for (const [tool, kind] of Object.entries(CARD_OF_TOOL)) {
      const entry = card.cards.find((c) => c.resource === CARD_URI(kind));
      expect(entry?.tools).toContain(tool);
    }
    expect(card.cards.flatMap((c) => c.tools).length).toBe(Object.keys(CARD_OF_TOOL).length);
  });

  test("/llms.txt says results carry cards and how many", async () => {
    const { cardsLine, cardList } = await import("../src/core/mcp_card.ts");
    expect(cardsLine()).toContain("_meta.ui.resourceUri");
    expect(cardsLine()).toContain(`${cardList().length} cards`);
  });
});
