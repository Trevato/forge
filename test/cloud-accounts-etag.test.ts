/** GET /api/v1/cloud/accounts carries a weak ETag and answers a repeat with 304 until an account or its use changes (#9206). */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, net, removeAccount } from "../src/actions/cloud.ts";
import { createToken } from "../src/core/tokens.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { weakEtag } from "../src/http/etag.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
net.fetch = async () => new Response(JSON.stringify({ login: "octo" }), { status: 200 });

let dataDir = "";
let app: App, servers: Servers;
let alice: User;
let adminTok = "", otherAdminTok = "", roTok = "", bobTok = "";
let clock = Date.now();
const asAdmin = (headers: Record<string, string> = {}, token = adminTok) =>
  fetch(`${servers.url}/api/v1/cloud/accounts`, { headers: { authorization: `Bearer ${token}`, ...headers } });
const tagOf = async (token = adminTok) => {
  const r = await asAdmin({}, token);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("etag")!;
};
/** Moves past the one-minute declaration cache. */
const later = () => {
  clock += 61_000;
};
const declare = (owner: string, name: string, uses: unknown[]) =>
  commitFiles(repoDir(app.reposRoot, owner, name), {
    branch: "main",
    message: "cloud",
    files: [{ path: "cloud.json", content: JSON.stringify({ uses }) }],
    author: { name: "T", email: "t@forge.test" },
  });

beforeAll(async () => {
  spyOn(Date, "now").mockImplementation(() => clock);
  dataDir = await mkdtemp(join(tmpdir(), "forge-cloudetag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
    if (!made.ok) throw new Error(made.error);
  }
  alice = getUserByName(app.db, "alice")!;
  const carol = getUserByName(app.db, "carol")!;
  app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(carol.id);
  adminTok = createToken(app.db, alice.id, "admin", "admin").token;
  roTok = createToken(app.db, alice.id, "ro", "ro").token;
  bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "bob", "admin").token;
  otherAdminTok = createToken(app.db, carol.id, "carol", "admin").token;
  const added = await addAccount(app, alice, "github", "main", "ghp_first9Zq4TxLm7Kp2Vb8nWcR5");
  if (!added.ok) throw new Error(String(added.error));
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("200 carries a weak tag, private no-cache and vary; a repeat is a bodiless 304 with the floor headers", async () => {
  const res = await asAdmin();
  expect(res.status).toBe(200);
  const tag = res.headers.get("etag")!;
  expect(tag).toMatch(/^W\//);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(await res.text()).accounts).toHaveLength(1);
  const again = await asAdmin({ "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
  const stale = await asAdmin({ "if-none-match": 'W/"nope"' });
  expect(stale.status).toBe(200);
});

test("an account linked or removed, and a repository starting or stopping a vendor, move the tag", async () => {
  let t = await tagOf();
  const moved = async (what: string) => {
    later();
    const next = await tagOf();
    expect(next, what).not.toBe(t);
    expect((await asAdmin({ "if-none-match": next })).status, what).toBe(304);
    t = next;
  };
  expect((await asAdmin({ "if-none-match": t })).status).toBe(304);

  const added = await addAccount(app, alice, "github", "second", "ghp_second9Zq4TxLm7Kp2Vb8nWcR5");
  expect(added.ok).toBe(true);
  await moved("linked");

  const repo = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "site", visibility: "private" });
  if (!repo.ok) throw new Error("repo");
  await declare("alice", "site", [{ vendor: "github", use: "cdn", why: "builds" }]);
  await moved("a repository starts a vendor");
  await declare("alice", "site", []);
  await moved("a repository stops a vendor");

  const removed = removeAccount(app, alice, "github", "second");
  expect(removed.ok).toBe(true);
  await moved("removed");
});

test("the tag is of the exact bytes sent, so viewers shown different bodies cannot share one", async () => {
  const carol = getUserByName(app.db, "carol")!;
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: carol.id, name: "hers", visibility: "private" });
  if (!repo.ok) throw new Error("repo");
  await declare("carol", "hers", [{ vendor: "github", use: "cdn", why: "hers alone" }]);
  later();
  for (const token of [adminTok, otherAdminTok]) {
    const res = await asAdmin({}, token);
    const text = await res.text();
    expect(res.headers.get("etag")).toBe(weakEtag(text));
  }
  // A tag over any other bytes is not held.
  const old = await asAdmin({ "if-none-match": weakEtag("{}") });
  expect(old.status).toBe(200);
});

test("no session, a read-only token and a non-admin answer as before, with no tag, even holding If-None-Match: *", async () => {
  const star = { "if-none-match": "*" };
  const anon = await fetch(`${servers.url}/api/v1/cloud/accounts`, { headers: star });
  expect(anon.status).toBe(401);
  expect(anon.headers.get("etag")).toBeNull();
  const ro = await asAdmin(star, roTok);
  expect(ro.status).toBe(403);
  expect(ro.headers.get("etag")).toBeNull();
  const plain = await asAdmin({}, bobTok);
  const bob = await asAdmin(star, bobTok);
  expect(bob.status).toBe(404);
  expect(bob.status).toBe(plain.status);
  expect(await bob.text()).toBe(await plain.text());
  expect(bob.headers.get("etag")).toBeNull();
  expect((await asAdmin(star)).status).toBe(304);
});
