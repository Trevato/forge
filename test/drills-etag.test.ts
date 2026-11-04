/** GET /api/v1/admin/drills carries a weak ETag and answers a repeat with 304 until a drill's result changes (#9205). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { recordDrill } from "../src/core/domain_drills.ts";
import { DOMAINS } from "../src/kernel/domains.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", member = "", agentAdmin = "", admin2 = "";

const get = (token?: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/admin/drills`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-drills-etag-"));
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
  const bob = await mk("bob");
  const scribe = await mk("scribe", { agent: true, isAdmin: true });
  const carol = await mk("carol", { isAdmin: true });
  admin = createToken(app.db, alice.id, "a", "admin").token;
  member = createToken(app.db, bob.id, "b", "admin").token;
  agentAdmin = createToken(app.db, scribe.id, "c", "admin").token;
  admin2 = createToken(app.db, carol.id, "d", "admin").token;
}, 30_000);
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag over the body, private no-cache and vary; a repeat is a bodiless 304 with the floor", async () => {
  const res = await get(admin);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const text = await res.text();
  expect(Object.keys(JSON.parse(text))).toEqual(["items", "next_cursor"]);
  const tag = res.headers.get("etag")!;
  expect(tag).toBe(weakEtag(text));
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  const again = await get(admin, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a drill recorded moves the tag, and a stale tag gets the new body", async () => {
  const first = await get(admin);
  await first.text();
  const before = first.headers.get("etag")!;
  const d = DOMAINS.find((x) => x.drill.name !== null)!;
  recordDrill(app.db, "alice", d.key, { health: "ok", board: "ok" } as any, 5, { green: true, why: "back in 5s" } as any);
  const res = await get(admin, { "if-none-match": before });
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).not.toBe(before);
  expect(await res.text()).toContain("back in 5s");
  recordDrill(app.db, "alice", d.key, { health: "ok", board: "ok" } as any, 9, { green: false, why: "stayed down" } as any);
  const third = await get(admin, { "if-none-match": tag });
  expect(third.status).toBe(200);
  expect(third.headers.get("etag")).not.toBe(tag);
});

test("another admin shown the same body shares the tag; the tag is of the bytes, not the viewer", async () => {
  const a = await get(admin);
  const b = await get(admin2, { "if-none-match": a.headers.get("etag")! });
  expect(b.status).toBe(304);
});

test("no session, a member and an agent admin answer as before with no ETag, even holding *", async () => {
  const none = await get(undefined, { "if-none-match": "*" });
  expect(none.status).toBe(401);
  expect(none.headers.get("etag")).toBeNull();
  for (const t of [member, agentAdmin]) {
    const r = await get(t, { "if-none-match": "*" });
    expect(r.status).toBe(403);
    expect(r.headers.get("etag")).toBeNull();
  }
});
