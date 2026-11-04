/** GET …/iterations carries a weak ETag and answers a repeat with 304 until a fork in the family moves (#9223). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo, deleteRepo, forkRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { forget } from "../src/core/ttl_cache.ts";
import { createUser } from "../src/core/users.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir = "";
let app: App, servers: Servers;
let alice: any, bob: any, carol: any, parent: any, bobFork: any;
let bearer = "";
const URL_ = () => `${servers.url}/api/v1/repos/alice/app/iterations`;
const get = (headers: Record<string, string> = {}) => fetch(URL_(), { headers });
const tagOf = async () => {
  const r = await get();
  await r.text();
  return r.headers.get("etag")!;
};
async function changed(before: string, what: string): Promise<string> {
  // The branch lists behind the body are kept for a few seconds; a push shows once they lapse.
  forget(app);
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
const pin = async (repo: any, who: any, label: string, oid: string, extra: { parent?: string } = {}) => {
  const p = await pinBuild(app, who, repo, { label, oid, ...extra });
  if (!p.ok) throw new Error(JSON.stringify(p.error));
};
const commit = async (repo: any, who: any, message: string, branch = "main") => {
  const c = await commitToBranch(app, who, repo, { branch, message, files: [{ path: `${message}.txt`, content: `${message}\n` }] });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  return c.value.commitOid as string;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-iteretag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = await mk("alice");
  bob = await mk("bob");
  carol = await mk("carol");
  const made = await createRepo(app, alice, { name: "app", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  parent = made.value;
  await pin(parent, alice, "v1", await commit(parent, alice, "one"));
  const f = await forkRepo(app, bob, parent);
  if (!f.ok) throw new Error("fork");
  bobFork = f.value;
  await pin(bobFork, bob, "b1", await commit(bobFork, bob, "bob one"), { parent: "alice/app:v1" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "bob", password: "a-good-passphrase", name: "cli", scope: "ro" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag over the body, private no-cache and vary; a repeat is a bodiless 304 with the floor", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const text = await res.text();
  const body = JSON.parse(text);
  expect(body.forks.length).toBeGreaterThan(1);
  expect(Object.keys(body)).toEqual(["forks", "lanes"]);
  const tag = res.headers.get("etag")!;
  expect(tag).toBe(weakEtag(text));
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  const again = await get({ "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a fork pushed, the parent pushed, a fork made and a fork deleted each change the tag", async () => {
  let tag = await tagOf();
  await commit(bobFork, bob, "side work", "side");
  tag = await changed(tag, "fork pushed");
  await commit(parent, alice, "side parent", "wip");
  tag = await changed(tag, "parent pushed");
  const c = await forkRepo(app, carol, parent);
  if (!c.ok) throw new Error("fork");
  tag = await changed(tag, "fork made");
  expect((await deleteRepo(app, carol, c.value)).ok).toBe(true);
  await changed(tag, "fork deleted");
});

test("a fork turned private moves the tag, and two viewers shown different bodies never share one", async () => {
  const before = await tagOf();
  const r = await updateRepoSettings(app, bob, bobFork, { visibility: "private" });
  expect(r.ok).toBe(true);
  const stranger = await changed(before, "fork turned private");
  const owner = await get({ authorization: `Bearer ${bearer}` });
  expect(owner.status).toBe(200);
  const ownerTag = owner.headers.get("etag")!;
  expect(ownerTag).not.toBe(stranger);
  expect(await owner.text()).toContain('"bob/app"');
  const replay = await get({ "if-none-match": ownerTag });
  expect(replay.status).toBe(200);
  expect(await replay.text()).not.toContain('"bob/app"');
  const own = await get({ authorization: `Bearer ${bearer}`, "if-none-match": ownerTag });
  expect(own.status).toBe(304);
});

test("a missing repository is a 404 with no ETag, even holding *", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/nope/iterations`, { headers: { "if-none-match": "*" } });
  expect(res.status).toBe(404);
  expect(res.headers.get("etag")).toBeNull();
});
