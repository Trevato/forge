/** GET /api/v1/admin/people, /admin/invites and /admin/accounts carry a weak ETag and answer a repeat with 304 until who has access changes (#9224). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { redeemInvite } from "../src/core/invites.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const ROUTES = ["people", "invites", "accounts"] as const;
type Route = (typeof ROUTES)[number];

let dataDir = "";
let app: App, servers: Servers;
let sam: User, bob: User;
let adminTok = "", roTok = "", rwTok = "", bobTok = "";
const url = (route: Route, query = "") => `${servers.url}/api/v1/admin/${route}${query}`;
const get = (route: Route, headers: Record<string, string> = {}, query = "") => fetch(url(route, query), { headers });
const asSam = (route: Route, headers: Record<string, string> = {}, query = "") =>
  get(route, { authorization: `Bearer ${adminTok}`, ...headers }, query);
const tags = async (): Promise<Record<Route, string>> => {
  const out = {} as Record<Route, string>;
  for (const route of ROUTES) {
    const r = await asSam(route);
    expect(r.status).toBe(200);
    await r.text();
    out[route] = r.headers.get("etag")!;
  }
  return out;
};
/** Each named route's tag moved and settles to a 304 again; the rest held still. */
async function moved(before: Record<Route, string>, what: string, which: Route[]): Promise<Record<Route, string>> {
  const after = await tags();
  for (const route of ROUTES) {
    if (which.includes(route)) expect(after[route], `${what}: ${route}`).not.toBe(before[route]);
    const again = await asSam(route, { "if-none-match": after[route] });
    expect(again.status, `${what}: ${route}`).toBe(304);
  }
  return after;
}
const mk = async (username: string) => {
  const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: username === "sam" });
  if (!r.ok) throw new Error("user");
  return r.value;
};
const post = (path: string, body: unknown, method = "POST") =>
  fetch(`${servers.url}/api/v1/admin/${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${adminTok}` },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-adminpeopleetag-"));
  app = createApp({ dataDir, port: 0 });
  sam = await mk("sam");
  bob = await mk("bob");
  await mk("carol");
  proveAll(app);
  servers = await serve(app);
  adminTok = createToken(app.db, sam.id, "admin", "admin").token;
  roTok = createToken(app.db, sam.id, "ro", "ro").token;
  rwTok = createToken(app.db, sam.id, "rw", "rw").token;
  bobTok = createToken(app.db, bob.id, "bob", "rw").token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each route answers 200 with a weak tag, private no-cache and vary over the same body; a repeat is a bodiless 304 with the floor headers", async () => {
  const made = await post("invites", { days: 7 });
  expect(made.status).toBe(201);
  for (const route of ROUTES) {
    const res = await asSam(route);
    expect(res.status, route).toBe(200);
    const tag = res.headers.get("etag")!;
    expect(tag, route).toMatch(/^W\//);
    expect(res.headers.get("cache-control"), route).toBe("private, no-cache");
    expect(res.headers.get("vary"), route).toContain("authorization, cookie");
    expect(res.headers.get("content-type"), route).toBe("application/json");
    const text = await res.text();
    expect(JSON.parse(text).items.length, route).toBeGreaterThan(0);
    const again = await asSam(route, { "if-none-match": tag });
    expect(again.status, route).toBe(304);
    expect(again.headers.get("etag"), route).toBe(tag);
    expect(again.headers.get("cache-control"), route).toBe("private, no-cache");
    expect(again.headers.get("vary"), route).toContain("authorization, cookie");
    expect(again.headers.get("x-content-type-options"), route).toBe("nosniff");
    expect(again.headers.get("content-security-policy"), route).not.toBeNull();
    expect(again.headers.get("referrer-policy"), route).not.toBeNull();
    expect(await again.text(), route).toBe("");
  }
});

test("a person added, made admin, suspended or removed, and an invite made, used or revoked move the tag", async () => {
  let t = await tags();

  const dave = await mk("dave");
  t = await moved(t, "person added", ["people", "accounts"]);

  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(dave.id);
  t = await moved(t, "made admin", ["people"]);
  app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(dave.id);
  t = await moved(t, "admin taken back", ["people"]);

  const suspended = await post("accounts/carol/suspend", {});
  expect(suspended.status).toBe(200);
  t = await moved(t, "suspended", ["accounts"]);

  const made = await post("invites", { days: 7 });
  expect(made.status).toBe(201);
  const invite = (await made.json()) as { id: string; token: string };
  t = await moved(t, "invite made", ["invites"]);

  const erin = await mk("erin");
  expect(redeemInvite(app.db, invite.token, erin.id)).toBe(true);
  t = await moved(t, "invite used", ["invites"]);

  const other = (await (await post("invites", { days: 3 })).json()) as { id: string };
  t = await tags();
  const revoked = await fetch(url("invites") + `/${other.id}`, { method: "DELETE", headers: { authorization: `Bearer ${adminTok}` } });
  expect(revoked.status).toBe(200);
  t = await moved(t, "invite revoked", ["invites"]);

  const removed = await fetch(url("accounts") + "/dave", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminTok}` },
    body: JSON.stringify({ confirm: true }),
  });
  expect(removed.status).toBeLessThan(300);
  await removed.text();
  await moved(t, "person removed", ["people", "accounts"]);
});

test("limit and cursor move the tag, and one page's tag buys another page nothing", async () => {
  for (const route of ROUTES) {
    const whole = await asSam(route);
    const wholeTag = whole.headers.get("etag")!;
    await whole.text();
    const first = await asSam(route, {}, "?limit=1");
    expect(first.status, route).toBe(200);
    const firstTag = first.headers.get("etag")!;
    await first.text();
    const second = await asSam(route, {}, "?limit=1&cursor=1");
    const secondTag = second.headers.get("etag")!;
    const secondBody = await second.text();
    expect(firstTag, route).not.toBe(wholeTag);
    expect(secondTag, route).not.toBe(firstTag);
    const replay = await asSam(route, { "if-none-match": firstTag }, "?limit=1&cursor=1");
    expect(replay.status, route).toBe(200);
    expect(await replay.text(), route).toBe(secondBody);
    const own = await asSam(route, { "if-none-match": secondTag }, "?limit=1&cursor=1");
    expect(own.status, route).toBe(304);
  }
});

test("a non-admin, a token short of the scope, and a bad limit or cursor answer as before, with no tag, even holding If-None-Match: *", async () => {
  const star = { "if-none-match": "*" };
  for (const route of ROUTES) {
    const anon = await get(route, star);
    expect(anon.status, route).not.toBe(304);
    expect(anon.status, route).toBeGreaterThanOrEqual(400);
    expect(anon.headers.get("etag"), route).toBeNull();

    const plain = await get(route, { authorization: `Bearer ${bobTok}` });
    const notAdmin = await get(route, { authorization: `Bearer ${bobTok}`, ...star });
    expect(notAdmin.status, route).toBeGreaterThanOrEqual(400);
    expect(notAdmin.status, route).toBe(plain.status);
    expect(await notAdmin.text(), route).toBe(await plain.text());
    expect(notAdmin.headers.get("etag"), route).toBeNull();

    for (const query of ["?limit=0", "?limit=abc", "?limit=999", "?cursor=0", "?cursor=x"]) {
      const bad = await asSam(route, star, query);
      expect(bad.status, `${route}${query}`).toBe(422);
      expect(bad.headers.get("etag"), `${route}${query}`).toBeNull();
      expect(bad.headers.get("cache-control"), `${route}${query}`).not.toBe("private, no-cache");
    }
  }

  // people asks for the admin scope; invites and accounts for ro.
  const shortOfAdmin = await get("people", { authorization: `Bearer ${roTok}`, ...star });
  expect(shortOfAdmin.status).toBe(403);
  expect(shortOfAdmin.headers.get("etag")).toBeNull();
  const rwPeople = await get("people", { authorization: `Bearer ${rwTok}`, ...star });
  expect(rwPeople.status).toBe(403);
  expect(rwPeople.headers.get("etag")).toBeNull();
  for (const route of ["invites", "accounts"] as const) {
    const ro = await get(route, { authorization: `Bearer ${roTok}`, ...star });
    expect(ro.status, route).toBe(304);
  }
});
