/**
 * OAuth for the MCP, step one: the two discovery documents, the 401 that
 * names them, and dynamic client registration with its refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getClient } from "../src/core/oauth.ts";
import { migrations } from "../src/core/schema.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("oauth discovery and registration", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const register = (payload: unknown, raw?: string) =>
    fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(payload),
    });

  test("the protected-resource document names the resource and its server", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.resource).toBe(`${base}/mcp`);
    expect(doc.authorization_servers).toEqual([base]);
    expect(doc.scopes_supported).toEqual(["ro", "rw"]);
  });

  test("the authorization-server document offers S256 only", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.issuer).toBe(base);
    expect(doc.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${base}/oauth/token`);
    expect(doc.registration_endpoint).toBe(`${base}/oauth/register`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.scopes_supported).toEqual(["ro", "rw"]);
  });

  test("a 401 from /mcp names the resource metadata", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toStartWith("Bearer ");
    expect(challenge).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
  });

  test("a valid registration is stored and returns a client_id", async () => {
    const res = await register({
      client_name: "Inspector",
      redirect_uris: ["https://client.example/cb", "http://localhost:6274/cb"],
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as any;
    expect(out.client_id).toBeString();
    expect(out.token_endpoint_auth_method).toBe("none");
    const stored = getClient(app.db, out.client_id);
    expect(stored?.name).toBe("Inspector");
    expect(stored?.redirectUris).toEqual([
      "https://client.example/cb",
      "http://localhost:6274/cb",
    ]);
  });

  test("refused registrations", async () => {
    const bad: [string, unknown][] = [
      ["javascript uri", { redirect_uris: ["javascript:alert(1)"] }],
      ["plain http to a remote host", { redirect_uris: ["http://evil.example/cb"] }],
      ["a fragment", { redirect_uris: ["https://client.example/cb#x"] }],
      ["missing redirect", { client_name: "x" }],
      ["empty redirects", { redirect_uris: [] }],
      ["a non-string redirect", { redirect_uris: [42] }],
      [
        "an oversized name",
        { client_name: "n".repeat(101), redirect_uris: ["https://a.example/cb"] },
      ],
      [
        "a confidential client",
        {
          token_endpoint_auth_method: "client_secret_basic",
          redirect_uris: ["https://a.example/cb"],
        },
      ],
    ];
    for (const [label, payload] of bad) {
      const res = await register(payload);
      expect({ label, status: res.status }).toEqual({ label, status: 400 });
      expect(((await res.json()) as any).error).toStartWith("invalid_");
    }
    const garbage = await register(undefined, "not json");
    expect(garbage.status).toBe(400);
    const count = app.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM oauth_client")
      .get()!.n;
    expect(count).toBe(1);
  });

  test("registration is limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await register({})).status;
    expect(last).toBe(429);
  });

  test("the migration is idempotent", () => {
    const ddl = migrations[migrations.length - 1]!;
    expect(ddl).toContain("oauth_client");
    expect(() => app.db.exec(ddl)).not.toThrow();
    expect(() => app.db.exec(ddl)).not.toThrow();
  });
});
