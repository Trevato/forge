/** GET …/forks carries a weak ETag and answers a repeat with 304 until a fork or the parent moves (#9168). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, deleteRepo, forkRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir = "";
let app: App, servers: Servers;
let alice: any, bob: any, carol: any, parent: any, bobFork: any;
const URL_ = () => `${servers.url}/api/v1/repos/alice/app/forks`;
const get = (q = "", headers: Record<string, string> = {}) => fetch(`${URL_()}${q}`, { headers });
const tagOf = async (q = "") => {
  const r = await get(q);
  await r.text();
  return r.headers.get("etag")!;
};
async function changed(before: string, what: string): Promise<string> {
  const res = await get("", { "if-none-match": before });
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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-forksetag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = await mk("alice");
  bob = await mk("bob");
  carol = await mk("carol");
  const made = await createRepo(app, alice, { name: "app", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  parent = made.value;
  await commitToBranch(app, alice, parent, { message: "one", files: [{ path: "a.txt", content: "x\n" }] });
  const f = await forkRepo(app, bob, parent);
  if (!f.ok) throw new Error("fork");
  bobFork = f.value;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  await res.text();
  const again = await get("", { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a fork pushed, a fork made, the parent moving and a fork deleted each change the tag", async () => {
  let tag = await tagOf();
  await commitToBranch(app, bob, bobFork, { message: "two", files: [{ path: "b.txt", content: "y\n" }] });
  tag = await changed(tag, "fork pushed");
  const c = await forkRepo(app, carol, parent);
  if (!c.ok) throw new Error("fork");
  tag = await changed(tag, "fork made");
  await commitToBranch(app, alice, parent, { message: "three", files: [{ path: "c.txt", content: "z\n" }] });
  tag = await changed(tag, "parent moved");
  const gone = await deleteRepo(app, carol, c.value);
  expect(gone.ok).toBe(true);
  await changed(tag, "fork deleted");
});

test("limit and cursor make different tags", async () => {
  const d = await forkRepo(app, alice, parent, "mine");
  expect(d.ok).toBe(true);
  const all = await tagOf();
  const one = await tagOf("?limit=1");
  expect(one).not.toBe(all);
  const first = await (await get("?limit=1")).json() as { next_cursor: string | null };
  expect(first.next_cursor).not.toBeNull();
  expect(await tagOf(`?limit=1&cursor=${first.next_cursor}`)).not.toBe(one);
});

test("a viewer who cannot see a private fork never shares a tag with one who can", async () => {
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "bob", password: "a-good-passphrase", name: "cli", scope: "ro" }),
  });
  const bearer = ((await minted.json()) as { token: string }).token;
  const r = await updateRepoSettings(app, bob, bobFork, { visibility: "private" });
  expect(r.ok).toBe(true);
  const owner = await get("", { authorization: `Bearer ${bearer}` });
  const stranger = await get();
  expect(owner.status).toBe(200);
  expect(stranger.status).toBe(200);
  const ownerTag = owner.headers.get("etag")!;
  const strangerTag = stranger.headers.get("etag")!;
  expect(ownerTag).not.toBe(strangerTag);
  expect(await owner.text()).toContain('"bob"');
  expect(await stranger.text()).not.toContain('"bob"');
  // The owner's tag buys a stranger nothing.
  const replay = await get("", { "if-none-match": ownerTag });
  expect(replay.status).toBe(200);
  expect(await replay.text()).not.toContain('"bob"');
  // The owner's own repeat is still a 304.
  const again = await get("", { authorization: `Bearer ${bearer}`, "if-none-match": ownerTag });
  expect(again.status).toBe(304);
});

test("a 404 and a bad page parameter carry no ETag", async () => {
  const missing = await fetch(`${servers.url}/api/v1/repos/alice/nope/forks`);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
  const bad = await get("?limit=abc");
  expect(bad.status).toBeGreaterThanOrEqual(400);
  expect(bad.headers.get("etag")).toBeNull();
});
