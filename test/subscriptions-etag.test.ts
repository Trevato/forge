/** GET /api/v1/admin/subscriptions carries a weak ETag and answers a repeat with 304 until a subscription changes (#9213). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addSubscription, deleteSubscription, setBudget, setGrants } from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let admin = "";
let member = "";

const get = (token: string | null, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/admin/subscriptions`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const tagNow = async () => {
  const r = await get(admin);
  await r.text();
  return r.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-subs-etag-"));
  app = createApp({ dataDir, port: 0, url: "https://forge.example" });
  servers = await serve(app);
  const mk = async (username: string, extra: Record<string, unknown> = {}) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", ...extra });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", { adminIfFirst: true });
  const bob = await mk("bob");
  admin = createToken(app.db, alice.id, "a", "admin").token;
  member = createToken(app.db, bob.id, "b", "admin").token;
}, 30_000);
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const add = (name: string) => {
  const r = addSubscription(app.db, dataDir, { name, token: `sk-ant-api03-${name}-secret-0123456789abcdef` });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

test("200 carries a weak tag over the body, private no-cache and vary", async () => {
  const res = await get(admin);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(JSON.parse(text).items).toBeArray();
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("etag")).toBe(weakEtag(text));
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
});

test("a repeat holding the tag is a bodiless 304 with the same headers and the floor", async () => {
  const first = await get(admin);
  const tag = first.headers.get("etag")!;
  await first.text();
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

test("adding, retargeting and removing a subscription each move the tag", async () => {
  const t0 = await tagNow();
  const s = add("work");
  const t1 = await tagNow();
  expect(t1).not.toBe(t0);
  const stale = await get(admin, { "if-none-match": t0 });
  expect(stale.status).toBe(200);
  await stale.text();
  setGrants(app.db, "acme/site", "", [s.id]);
  const t2 = await tagNow();
  expect(t2).not.toBe(t1);
  setBudget(app.db, s.id, 5);
  const t3 = await tagNow();
  expect(t3).not.toBe(t2);
  expect(deleteSubscription(app.db, s.id)).toBe(true);
  expect(await tagNow()).not.toBe(t3);
});

test("no session is 401 and a refused viewer 403, with no ETag even holding *", async () => {
  const anon = await get(null, { "if-none-match": "*" });
  expect(anon.status).toBe(401);
  expect(anon.headers.get("etag")).toBeNull();
  await anon.text();
  const bob = await get(member, { "if-none-match": "*" });
  expect(bob.status).toBe(403);
  expect(bob.headers.get("etag")).toBeNull();
  await bob.text();
  const replay = await get(member, { "if-none-match": await tagNow() });
  expect(replay.status).toBe(403);
  expect(replay.headers.get("etag")).toBeNull();
});
