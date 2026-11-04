/** GET /api/v1/version carries an ETag; a repeat is a 304 until FORGE_API_VERSION changes. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { FORGE_API_VERSION } from "../src/http/api/forge_origin.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("version ETag", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  const V = "/api/v1/version";
  const body = JSON.stringify({ version: FORGE_API_VERSION, software: "forge" });
  const expected = weakEtag(body);

  const get = (extra: Record<string, string> = {}) =>
    fetch(`${servers.url}${V}`, { headers: extra });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-version-etag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    if (!u.ok) throw new Error(u.error);
    token = createToken(app.db, u.value.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("200 with a weak tag derived from the body, no-cache, no vary", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(expected);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("vary") ?? "").not.toMatch(/authorization|cookie/i);
    expect(await res.text()).toBe(body);
  });

  test("a repeat is a 304 with the same headers, no body and the security floor", async () => {
    const res = await get({ "if-none-match": expected });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(expected);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("vary") ?? "").not.toMatch(/authorization|cookie/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).not.toBeNull();
    expect(await res.text()).toBe("");
    expect((await get({ "if-none-match": "*" })).status).toBe(304);
  });

  test("a signed-in and an anonymous caller get the same tag", async () => {
    const anon = await get();
    const user = await get({ authorization: `Bearer ${token}` });
    expect(user.headers.get("etag")).toBe(anon.headers.get("etag"));
    expect((await get({ authorization: `Bearer ${token}`, "if-none-match": expected })).status).toBe(304);
  });

  test("a stale tag gets a 200 with the body", async () => {
    const res = await get({ "if-none-match": weakEtag("{}") });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });
});
