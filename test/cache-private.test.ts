import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { shellAsset, stylesheetAsset } from "../src/web/asset.ts";
import { TOOLBAR_PATH } from "../src/apps/toolbar.ts";
import { adminCookie } from "./helpers/admin.ts";
import { privateWhenSignedIn } from "../src/http/respond.ts";
import { quietLogs } from "./helpers/globals.ts";

/**
 * A shared cache that kept a signed-in answer would show one person's forge to
 * another. Every signed-in page and API answer says `private` or `no-store`;
 * only content-addressed assets are public and long-lived.
 *
 * Signed-out answers that may stay cacheable, and why: the content-addressed
 * assets (their name is their hash, so the bytes never change) and
 * `/opensearch.xml` (a static description, the same for everyone, an hour).
 * Every page and API answer is otherwise `no-cache` or `no-store` when
 * signed out; none is asserted public.
 */
describe("cache headers", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;
  quietLogs();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cache-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.local",
      password: "analytical-engine",
    });
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ name: "secret", visibility: "private" }),
      redirect: "manual",
    });
    await fetch(`${base}/ada/secret/issues/new`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ title: "hidden", body: "private body" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const signedIn = [
    "/",
    "/ada/secret",
    "/ada/secret/issues/1",
    "/asked",
    "/forges",
    "/api/v1/feed",
    "/api/v1/repos/ada/secret/issues/1",
  ];

  for (const path of signedIn) {
    test(`signed in, ${path} is private or no-store and never shared-cacheable`, async () => {
      const res = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
      expect(res.status).toBeLessThan(400);
      const control = (res.headers.get("cache-control") ?? "").toLowerCase();
      expect(control).toMatch(/\b(private|no-store)\b/);
      expect(control).not.toMatch(/\bpublic\b/);
      expect(control).not.toContain("s-maxage");
    });
  }

  for (const path of [shellAsset().path, stylesheetAsset().path, TOOLBAR_PATH]) {
    test(`${path} is content-addressed, public and immutable`, async () => {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    });
  }

  test("signed out, the static opensearch description may be public for an hour", async () => {
    const res = await fetch(`${base}/opensearch.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("a credential strips public and s-maxage from what a route wrote, and spares immutable assets", () => {
    const sign = new Request("http://x/", { headers: { cookie: "a=b" } });
    const made = privateWhenSignedIn(sign, new Response("", { headers: { "cache-control": "public, s-maxage=60, max-age=5" } }));
    expect(made.headers.get("cache-control")).toBe("private, max-age=5");
    const bare = privateWhenSignedIn(sign, new Response(""));
    expect(bare.headers.get("cache-control")).toBe("private");
    const anon = privateWhenSignedIn(new Request("http://x/"), new Response("", { headers: { "cache-control": "public, max-age=5" } }));
    expect(anon.headers.get("cache-control")).toBe("public, max-age=5");
    const asset = privateWhenSignedIn(sign, new Response("", { headers: { "cache-control": "public, max-age=31536000, immutable" } }));
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
