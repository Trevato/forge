/** Every refused REST call tells the caller what to do next: a `hint` on each 401, 403, 404, 409 and 422 (#10950). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { ROUTES } from "../src/contract/openapi.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { withHint } from "../src/http/respond.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const HINTED = new Set([401, 403, 404, 409, 422]);

describe("refusals carry a hint", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";
  let rw = "";
  let admin = "";
  const call = (method: string, path: string, auth: string | null, body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { accept: "application/json", "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-hints-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "hinty", email: "h@x.test", password: "a-long-hints-passphrase", isAdmin: false });
    if (!made.ok) throw new Error("user");
    token = createToken(app.db, getUserByName(app.db, "hinty")!.id, "t", "ro").token;
    const boss = await createUser(app.db, { origin: "seed", trusted: true, username: "bossy", email: "b@x.test", password: "a-long-hints-passphrase", isAdmin: true });
    if (!boss.ok) throw new Error("admin");
    admin = createToken(app.db, getUserByName(app.db, "bossy")!.id, "a", "admin").token;
    rw = createToken(app.db, getUserByName(app.db, "hinty")!.id, "w", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every OpenAPI route, called badly, answers a hint on 401/403/404/409/422", async () => {
    const seen = new Set<number>();
    for (const r of ROUTES) {
      const path = r.path.replace(/\{[^}]+\}/g, "nope");
      for (const auth of [null, token]) {
        const res = await fetch(`${servers.url}${path}`, {
          method: r.method.toUpperCase(),
          headers: { accept: "application/json", "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
          ...(r.method === "get" ? {} : { body: "{}" }),
        });
        if (!HINTED.has(res.status)) continue;
        const text = await res.text();
        let body: { hint?: unknown } | null = null;
        try { body = JSON.parse(text); } catch { continue; } // a page, not an API answer
        if (body === null || typeof (body as { error?: unknown }).error !== "string") continue;
        seen.add(res.status);
        expect(typeof body.hint, `${r.method} ${r.path} -> ${res.status}`).toBe("string");
        expect((body.hint as string).trim().length, `${r.method} ${r.path}`).toBeGreaterThan(0);
      }
    }
    // Calls built to provoke each status, so the walk cannot pass by seeing only two.
    const provoked: Record<string, Response> = {
      "401 no token": await call("POST", "/api/v1/repos", null, { name: "x" }),
      "403 read-only token writes": await call("POST", "/api/v1/repos", token, { name: "ro-write" }),
      "403 not admin": await call("GET", "/api/v1/admin/subscriptions", rw),
      "404 unknown path": await call("GET", "/api/v1/nope", token),
      "409 wrong state: resume when not in maintenance": await call("POST", "/api/v1/admin/maintenance/resume", admin, {}),
      "422 bad body": await call("GET", "/api/v1/repos?limit=abc", token),
    };
    for (const [what, res] of Object.entries(provoked)) {
      const body = (await res.json()) as { error?: string; hint?: string };
      expect(Number(what.slice(0, 3)), what).toBe(res.status);
      expect(typeof body.hint, what).toBe("string");
      seen.add(res.status);
    }
    for (const status of HINTED) expect(seen.has(status), `status ${status} was never exercised`).toBe(true);
  }, 120_000);

  test("the common codes read in their own words, not the generic status sentence", async () => {
    const hint = (error: string, status: number) => (withHint({ error }, status) as { hint: string }).hint;
    expect(hint("held", 409)).toContain("hold");
    expect(hint("review_required", 409)).toContain("review");
    expect(hint("checks_required", 409)).toContain("check");
    expect(hint("invalid", 422)).toContain("field");
    expect(hint("not_admin", 403)).toContain("administrators");
    expect(hint("held", 409)).not.toBe(hint("something_else", 409));
  });

  test("a hint never echoes request text, and 404 reads the same for missing and private", () => {
    const a = withHint({ error: "not_found", message: "x" }, 404) as { hint: string };
    const b = withHint({ error: "not_found", message: "<script>y</script>" }, 404) as { hint: string };
    expect(a.hint).toBe(b.hint);
    expect(a.hint).not.toContain("<");
  });

  test("a site's own hint is kept, and other statuses are left alone", () => {
    expect((withHint({ error: "x", hint: "mine" }, 409) as { hint: string }).hint).toBe("mine");
    expect(withHint({ error: "x" }, 400)).toEqual({ error: "x" });
    expect(withHint({ ok: true }, 404)).toEqual({ ok: true });
  });
});
