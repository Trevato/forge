/**
 * GET /api/v1/admin/capacity, /admin/limits and /admin/quotas carry a weak
 * ETag and answer a repeat with 304 until a limit, quota or capacity reading
 * changes (#9248).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", adminRo = "", admin2 = "", member = "", agentAdmin = "";

const ROUTES = [
  { path: "/admin/capacity", keys: ["items", "changes", "next_cursor"], set: ["/admin/capacity/checks.concurrency", "9"] },
  { path: "/admin/limits", keys: ["items", "changes", "next_cursor"], set: ["/admin/limits/share.daily_max", "9"] },
  { path: "/admin/quotas", keys: ["quotas", "changes"], set: ["/admin/quotas/previews", 4] },
] as const;

const get = (path: string, token?: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1${path}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
const put = (path: string, value: unknown) =>
  fetch(`${servers.url}/api/v1${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-admin-limits-etag-"));
  app = createApp({ dataDir, port: 0, url: "https://forge.example" });
  servers = await serve(app);
  const mk = async (username: string, extra: Record<string, unknown> = {}) => {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username,
      email: `${username}@forge.local`, password: "a-good-passphrase", ...extra,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", { adminIfFirst: true });
  const carol = await mk("carol", { isAdmin: true });
  const bob = await mk("bob");
  const scribe = await mk("scribe", { agent: true, isAdmin: true });
  admin = createToken(app.db, alice.id, "a", "admin").token;
  adminRo = createToken(app.db, alice.id, "r", "ro").token;
  admin2 = createToken(app.db, carol.id, "c", "admin").token;
  member = createToken(app.db, bob.id, "b", "admin").token;
  agentAdmin = createToken(app.db, scribe.id, "s", "admin").token;
}, 30_000);
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

for (const route of ROUTES) {
  test(`${route.path}: 200 carries a weak tag over the body; a repeat is a bodiless 304 with the floor`, async () => {
    const res = await get(route.path, adminRo);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(Object.keys(JSON.parse(text))).toEqual([...route.keys]);
    const tag = res.headers.get("etag")!;
    expect(tag).toBe(weakEtag(text));
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toContain("authorization, cookie");
    const again = await get(route.path, adminRo, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toContain("authorization, cookie");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("content-security-policy")).not.toBeNull();
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(await again.text()).toBe("");
  });

  test(`${route.path}: a change moves the tag and a stale tag gets the new body`, async () => {
    const first = await get(route.path, admin);
    const before = first.headers.get("etag")!;
    const old = await first.text();
    const [path, value] = route.set;
    expect((await put(path, value)).status).toBe(200);
    const res = await get(route.path, admin, { "if-none-match": before });
    expect(res.status).toBe(200);
    const tag = res.headers.get("etag")!;
    expect(tag).not.toBe(before);
    expect(await res.text()).not.toBe(old);
    expect((await put(path, null)).status).toBe(200);
    const third = await get(route.path, admin, { "if-none-match": tag });
    expect(third.status).toBe(200);
    expect(third.headers.get("etag")).not.toBe(tag);
  });

  test(`${route.path}: another admin shown the same bytes shares the tag; the tag is of the body, not the viewer`, async () => {
    const a = await get(route.path, admin);
    const b = await get(route.path, admin2, { "if-none-match": a.headers.get("etag")! });
    expect(b.status).toBe(304);
    expect(b.headers.get("etag")).toBe(weakEtag(await a.text()));
  });

  test(`${route.path}: no session, a member and an agent admin answer as before with no ETag, even holding *`, async () => {
    for (const t of [undefined, member, agentAdmin]) {
      const plain = await get(route.path, t);
      const held = await get(route.path, t, { "if-none-match": "*" });
      expect(plain.status).toBeGreaterThanOrEqual(400);
      expect(held.status).toBe(plain.status);
      expect(await held.text()).toBe(await plain.text());
      expect(held.headers.get("etag")).toBeNull();
      expect(plain.headers.get("etag")).toBeNull();
    }
  });
}
