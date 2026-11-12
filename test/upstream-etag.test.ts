/** GET …/upstream carries a weak ETag and answers a repeat with 304 until the upstream or its last check moves (#9245). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { noteCheck, putFollow } from "../src/core/upstream_follow.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir = "";
let app: App, servers: Servers;
let alice: any, repo: any;
let aliceBearer = "", bobBearer = "";
const URL_ = () => `${servers.url}/api/v1/repos/alice/app/upstream`;
const get = (headers: Record<string, string> = {}, bearer = aliceBearer) =>
  fetch(URL_(), { headers: bearer ? { authorization: `Bearer ${bearer}`, ...headers } : headers });
const tagOf = async () => {
  const r = await get();
  await r.text();
  return r.headers.get("etag")!;
};
async function changed(before: string, what: string): Promise<string> {
  const res = await get({ "if-none-match": before });
  expect(res.status, what).toBe(200);
  await res.text();
  const tag = res.headers.get("etag")!;
  expect(tag, what).not.toBe(before);
  return tag;
}
const mk = async (username: string) => {
  const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: username === "alice" });
  if (!r.ok) throw new Error("user");
  promote(app.db, r.value);
  return r.value;
};
const follow = (url: string, branch = "main", enabled = true) =>
  putFollow(app.db, { repoId: repo.id, url, branch, enabled, byId: alice.id, originId: "" });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-upstreametag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = await mk("alice");
  const bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "app", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  repo = made.value;
  aliceBearer = createToken(app.db, alice.id, "a", "ro").token;
  bobBearer = createToken(app.db, bob.id, "b", "ro").token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  follow("https://example.com/a.git");
  const res = await get();
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(((await res.json()) as any).following.url).toBe("https://example.com/a.git");
  const again = await get({ "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("the upstream changed, a check recorded and the upstream removed each change the tag", async () => {
  let tag = await tagOf();
  follow("https://example.com/b.git");
  tag = await changed(tag, "url changed");
  noteCheck(app.db, repo.id, { at: new Date().toISOString(), tip: "abc1234", behind: 3, error: "" });
  tag = await changed(tag, "check recorded");
  noteCheck(app.db, repo.id, { at: new Date(Date.now() + 1000).toISOString(), tip: "abc1234", behind: 3, error: "" });
  tag = await changed(tag, "check repeated at a new time");
  follow("https://example.com/b.git", "main", false);
  tag = await changed(tag, "disabled");
  app.db.query("DELETE FROM repo_upstream WHERE repo_id = ?1").run(repo.id);
  const res = await get({ "if-none-match": tag });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ following: null });
  expect(res.headers.get("etag")).not.toBe(tag);
});

test("a non-admin, an anonymous caller and a missing repository answer as before with no ETag, even for *", async () => {
  follow("https://example.com/c.git");
  for (const [what, res] of [
    ["non-admin", await get({ "if-none-match": "*" }, bobBearer)],
    ["anonymous", await get({ "if-none-match": "*" }, "")],
    ["missing", await fetch(`${servers.url}/api/v1/repos/alice/nope/upstream`, { headers: { authorization: `Bearer ${aliceBearer}`, "if-none-match": "*" } })],
  ] as const) {
    expect(res.status, what).not.toBe(304);
    expect(res.status, what).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("etag"), what).toBeNull();
    await res.text();
  }
  const owner = await get({ "if-none-match": "*" });
  expect(owner.status).toBe(304);
});

test("two viewers shown different bodies never share a tag", async () => {
  const admin = await tagOf();
  const stranger = await get({ "if-none-match": admin }, bobBearer);
  expect(stranger.status).toBeGreaterThanOrEqual(400);
  expect(stranger.headers.get("etag")).toBeNull();
});
