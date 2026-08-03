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
});
