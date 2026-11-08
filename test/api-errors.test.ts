import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

// The arena's dominant friction after the read gap: every miss looked the same,
// so an agent couldn't tell a typo'd URL from a resource that isn't there. The
// contract is now a stable `error` code plus a human `message`, with `no_route`
// distinct from `not_found`.
describe("API errors are distinguishable and self-describing", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  const err = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    const body = (await res.json()) as { error: string; message?: string };
    return { status: res.status, ...body };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apierr-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    // A real user + public repo so a *resource* miss is reachable (a private
    // repo would mask the route itself).
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "dev",
        email: "d@f.dev",
        password: "api-errors-pass",
      }),
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a path matching no route is no_route, and echoes the path", async () => {
    const r = await err("/api/v1/repos/dev/lib/pullz"); // typo: pullz
    expect(r.status).toBe(404);
    expect(r.error).toBe("no_route");
    expect(r.message).toContain("/api/v1/repos/dev/lib/pullz");
  });

  test("a real route with a missing resource is not_found", async () => {
    const r = await err("/api/v1/repos/dev/does-not-exist");
    expect(r.status).toBe(404);
    expect(r.error).toBe("not_found");
    expect(typeof r.message).toBe("string");
  });

  test("no_route and not_found are actually different codes", async () => {
    const route = await err("/api/v1/nonsense/path");
    const resource = await err("/api/v1/repos/dev/nope");
    expect(route.error).toBe("no_route");
    expect(resource.error).toBe("not_found");
    expect(route.error).not.toBe(resource.error);
  });

  test("unauthorized and forbidden carry codes and messages too", async () => {
    // Creating a token needs credentials; omitting them is unauthorized.
    const noAuth = await err("/api/v1/user");
    expect(noAuth.status).toBe(401);
    expect(noAuth.error).toBe("unauthorized");
    expect(noAuth.message).toBeTruthy();
  });

  // The API's own base, and any other path under `/api/` that no route
  // claims, used to fall through to the studio's `/:owner`-shaped catch-all
  // page routes ("api" and "v1" read as an owner and a repo name) and answer
  // with thirty-three kilobytes of the not-found *page* — wrong shape, wrong
  // content-type, to a caller whose `accept` said `application/json`.
  test("/api and /api/v1 are JSON 404s, not the studio's HTML page", async () => {
    for (const path of ["/api", "/api/v1", "/api/v2/anything"]) {
      const res = await fetch(`${base}${path}`, {
        headers: { accept: "application/json" },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toStartWith("application/json");
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("no_route");
    }
  });

  // Content negotiation never rescues it either: a bare curl with no
  // `accept` header at all must still get JSON under `/api/`.
  test("/api/v1 is JSON even with no accept header", async () => {
    const res = await fetch(`${base}/api/v1`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("application/json");
  });

  // A page path outside `/api/` keeps the forge's own not-found page,
  // unchanged, for a browser that asks for HTML.
  test("a page path with accept: text/html still gets the HTML page", async () => {
    const res = await fetch(`${base}/this-owner-does-not-exist`, {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("text/html");
  });

  // The security floor is not the API's own responder's business — it is
  // applied once, above every response the forge writes — but a miss under
  // `/api/` must not be the one path that skips it.
  test("the security floor still covers a miss under /api/", async () => {
    const res = await fetch(`${base}/api/v1`, {
      headers: { accept: "application/json" },
    });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  test("a known API path under the wrong method is 405 with Allow, an unknown one stays no_route", async () => {
    const res = await fetch(`${base}/api/v1/repos`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("method_not_allowed");
    expect(body.message).toBe("PUT is not taken here; use GET, POST");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    const nope = await err("/api/v1/nope", { method: "PUT" });
    expect(nope.status).toBe(404);
    expect(nope.error).toBe("no_route");
  });
});
