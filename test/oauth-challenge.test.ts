/**
 * The 401 on /mcp and on the API is one challenge from one function: it names
 * the scopes, and says invalid_token only when a bearer was sent and refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const BASE = `Bearer realm="forge", resource_metadata="https://forge.example/.well-known/oauth-protected-resource", scope="ro rw"`;

describe("the bearer challenge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let expired = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-challenge-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    expired = createToken(app.db, made.value.id, "old", "rw", {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }).token;
  }, 30_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mcp = (authorization?: string) =>
    fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const api = (authorization?: string) =>
    fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: "{}",
    });

  for (const [name, call] of [["/mcp", mcp], ["the API", api]] as const) {
    test(`${name}: no token is the plain challenge with scopes`, async () => {
      const res = await call();
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(BASE);
    });
    test(`${name}: a garbage token is invalid_token`, async () => {
      const res = await call("Bearer forge_nonsense");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`${BASE}, error="invalid_token"`);
    });
    test(`${name}: an expired token is invalid_token`, async () => {
      const res = await call(`Bearer ${expired}`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`${BASE}, error="invalid_token"`);
    });
  }
});
