/** GET /api/v1/tokens carries a weak ETag and answers a repeat with 304 until a token is made, used or revoked (#9199). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createClient, listTokensWithClients } from "../src/core/oauth.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
let alice: User, bob: User;
let aliceCookie = "", bobCookie = "";
const url = () => `${servers.url}/api/v1/tokens`;
const get = (headers: Record<string, string> = {}) => fetch(url(), { headers });
const asAlice = (headers: Record<string, string> = {}) => get({ cookie: aliceCookie, ...headers });
const tagOf = async (cookie = aliceCookie) => {
  const r = await get({ cookie });
  await r.text();
  return r.headers.get("etag")!;
};
async function changed(before: string, what: string): Promise<string> {
  const res = await asAlice({ "if-none-match": before });
  expect(res.status, what).toBe(200);
  await res.text();
  const tag = res.headers.get("etag")!;
  expect(tag, what).not.toBe(before);
  // And it settles: the new tag is a 304 again.
  const again = await asAlice({ "if-none-match": tag });
  expect(again.status, what).toBe(304);
  return tag;
}
const mk = async (username: string) => {
  const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: username === "sam" });
  if (!r.ok) throw new Error("user");
  return r.value;
};
const signIn = async (username: string) => {
  const res = await fetch(`${servers.url}/api/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: servers.url },
    body: JSON.stringify({ username, password: "a-good-passphrase" }),
  });
  if (res.status !== 201) throw new Error(`sign in ${username}: ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tokensetag-"));
  app = createApp({ dataDir, port: 0 });
  await mk("sam");
  alice = await mk("alice");
  bob = await mk("bob");
  proveAll(app);
  servers = await serve(app);
  aliceCookie = await signIn("alice");
  bobCookie = await signIn("bob");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary over the same body; a repeat is a bodiless 304 with the floor headers", async () => {
  createToken(app.db, alice.id, "laptop", "rw");
  const res = await asAlice();
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.text()).toBe(JSON.stringify(listTokensWithClients(app.db, alice.id)));
  const again = await asAlice({ "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a token made, used, given a client, its client renamed, and revoked each move the tag", async () => {
  let tag = await tagOf();
  const made = await fetch(url(), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: aliceCookie, origin: servers.url },
    body: JSON.stringify({ name: "cli", scope: "ro" }),
  });
  expect(made.status).toBe(201);
  const minted = (await made.json()) as { id: string; token: string };
  tag = await changed(tag, "token made");

  const used = await fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${minted.token}` } });
  await used.text();
  tag = await changed(tag, "token used");

  const client = createClient(app.db, { name: "Harness", redirectUris: ["https://example.com/cb"] });
  app.db.query("INSERT INTO oauth_token (token_id, client_id) VALUES (?1, ?2)").run(minted.id, client.id);
  tag = await changed(tag, "client attached");
  app.db.query("UPDATE oauth_client SET name = 'Harness 2' WHERE id = ?1").run(client.id);
  tag = await changed(tag, "client renamed");

  const gone = await fetch(`${url()}/${minted.id}`, { method: "DELETE", headers: { cookie: aliceCookie, origin: servers.url } });
  expect(gone.status).toBe(204);
  await changed(tag, "token revoked");
});

test("two viewers shown different bodies never share a tag, and one's tag buys the other nothing", async () => {
  createToken(app.db, bob.id, "bob-box", "rw");
  const aliceTag = await tagOf(aliceCookie);
  const bobTag = await tagOf(bobCookie);
  expect(aliceTag).not.toBe(bobTag);
  const replay = await get({ cookie: bobCookie, "if-none-match": aliceTag });
  expect(replay.status).toBe(200);
  expect(await replay.text()).toContain("bob-box");
  const own = await get({ cookie: bobCookie, "if-none-match": bobTag });
  expect(own.status).toBe(304);
});

test("no session or account answers as before, with no tag, even holding If-None-Match: *", async () => {
  const anon = await get({ "if-none-match": "*" });
  expect(anon.status).toBe(401);
  expect(anon.headers.get("etag")).toBeNull();
  expect(anon.headers.get("cache-control")).not.toBe("private, no-cache");

  const bearer = createToken(app.db, alice.id, "agent", "rw").token;
  const viaToken = await get({ authorization: `Bearer ${bearer}`, "if-none-match": "*" });
  expect(viaToken.status).toBeGreaterThanOrEqual(400);
  expect(viaToken.status).not.toBe(304);
  expect(viaToken.headers.get("etag")).toBeNull();

  const forged = await asAlice({ origin: "https://evil.example", "sec-fetch-site": "cross-site", "if-none-match": "*" });
  expect(forged.status).toBe(403);
  expect(forged.headers.get("etag")).toBeNull();
});
