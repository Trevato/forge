/**
 * RFC 9728: `/.well-known/oauth-protected-resource` names this forge's /mcp
 * and its authorization server, from the configured URL and never a header.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("oauth protected resource metadata", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oprm-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("names the configured origin's /mcp, even when headers claim another", async () => {
    const res = await fetch(`${servers.url}/.well-known/oauth-protected-resource`, {
      headers: { "x-forwarded-host": "evil.test", "x-forwarded-proto": "http" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.resource).toBe("https://forge.example/mcp");
    expect(doc.resource_name).toBe("forge");
    expect(doc.resource_documentation).toBe("https://forge.example/llms.txt");
    expect(doc.authorization_servers).toEqual(["https://forge.example"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });
});
