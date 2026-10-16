/**
 * POST /oauth/register (RFC 7591): one good registration, and the refusals
 * the issue names — a remote http redirect, a missing name, an oversized body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getClient } from "../src/core/oauth.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("oauth client registration", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-register-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const register = (body: string) =>
    fetch(`${servers.url}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  const count = () =>
    app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM oauth_client").get()!.n;

  test("a name with https and loopback redirects is stored", async () => {
    const res = await register(
      JSON.stringify({
        client_name: "Inspector",
        redirect_uris: ["https://client.example/cb", "http://127.0.0.1:6274/cb"],
      }),
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as any;
    expect(getClient(app.db, out.client_id)?.name).toBe("Inspector");
    expect(getClient(app.db, out.client_id)?.redirectUris).toEqual([
      "https://client.example/cb",
      "http://127.0.0.1:6274/cb",
    ]);
  });

  test("an http redirect to a remote host is refused", async () => {
    const res = await register(
      JSON.stringify({ client_name: "x", redirect_uris: ["http://evil.example/cb"] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_redirect_uri");
  });

  test("a missing or blank name is refused", async () => {
    for (const name of [undefined, "", "   ", 7]) {
      const res = await register(
        JSON.stringify({ client_name: name, redirect_uris: ["https://a.example/cb"] }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe("invalid_client_metadata");
    }
  });

  test("an oversized body is refused", async () => {
    const res = await register(
      JSON.stringify({
        client_name: "x".repeat(20_000),
        redirect_uris: ["https://a.example/cb"],
      }),
    );
    expect(res.status).toBe(413);
    expect(count()).toBe(1);
  });
});
