/** GET …/following/proposals carries an ETag and answers a repeat with 304 (#9246). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let bobTok = "";
let bobId = "";
const PATH = "/api/v1/repos/bob/up/following/proposals";
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers });
const bob = (headers: Record<string, string> = {}) =>
  get(PATH, { authorization: `Bearer ${bobTok}`, ...headers });
const FAR = Date.now() + 10 * 365 * 86_400_000; // checked "recently": no ask of the parent
const add = (branch: string, number: number, state: string) =>
  app.db
    .query(
      `INSERT INTO upstream_proposal (repo_id, branch, number, title, source, state, reachable, checked_at, created_at)
       VALUES (?1, ?2, ?3, 't', 's', ?4, 1, ?5, ?5)`,
    )
    .run(bobId, branch, number, state, FAR);
const tagOf = async () => {
  const res = await bob();
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-proposals-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice: User = await mk("alice", true);
  const b: User = await mk("bob", false);
  promote(app.db, alice, b);
  const up = await createRepo(app, alice, { name: "up", visibility: "public" });
  if (!up.ok) throw new Error("repo");
  const solo = await createRepo(app, alice, { name: "solo", visibility: "private" });
  if (!solo.ok) throw new Error("repo");
  const fork = await forkRepo(app, b, up.value);
  if (!fork.ok) throw new Error(JSON.stringify(fork.error));
  bobId = fork.value.id;
  await Bun.write(
    join(dataDir, "parent.json"),
    JSON.stringify({
      upstream: "https://parent.invalid",
      proposal: { child: "kid", token: "tok-abcdefgh" },
      forgeCode: { repo: "bob/up", upstream: "root/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
    }),
  );
  bobTok = createToken(app.db, b.id, "b", "ro").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a weak tag over the body, private no-cache, vary", async () => {
  add("b1", 1, "open");
  const res = await bob();
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\/"/);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(((await res.json()) as { items: unknown[] }).items.length).toBe(1);
});

test("a repeat is a bodiless 304 with the same headers and the floor", async () => {
  const tag = await tagOf();
  const again = await bob({ "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(again.headers.get("content-security-policy")).not.toBeNull();
});

test("the tag moves when a proposal is made, answered, landed or withdrawn", async () => {
  let tag = await tagOf();
  const step = async (change: () => void) => {
    change();
    const res = await bob({ "if-none-match": tag });
    expect(res.status).toBe(200);
    const next = res.headers.get("etag")!;
    expect(next).not.toBe(tag);
    await res.text();
    tag = next;
  };
  await step(() => add("b2", 2, "open"));
  await step(() => app.db.query("UPDATE upstream_proposal SET state = 'merged' WHERE number = 2").run());
  await step(() => app.db.query("UPDATE upstream_proposal SET state = 'closed' WHERE number = 1").run());
  await step(() => app.db.query("DELETE FROM upstream_proposal WHERE number = 1").run());
});

test("viewers shown different bodies never share a tag", async () => {
  const signedIn = await tagOf();
  const anon = await get(PATH);
  expect(anon.status).toBe(200);
  await anon.text();
  // Same bytes share a tag; the vary header keeps caches apart. Different bytes must not.
  app.db.query("UPDATE upstream_proposal SET title = 'other' WHERE number = 2").run();
  expect(await tagOf()).not.toBe(signedIn);
});

test("a missing repository answers as before with no tag, even for *", async () => {
  const res = await get("/api/v1/repos/bob/nope/following/proposals", {
    authorization: `Bearer ${bobTok}`,
    "if-none-match": "*",
  });
  expect(res.status).toBe(404);
  expect(res.headers.get("etag")).toBeNull();
});

test("a repository the viewer cannot see answers 404 with no tag, even for *", async () => {
  const res = await get("/api/v1/repos/alice/solo/following/proposals", {
    authorization: `Bearer ${bobTok}`,
    "if-none-match": "*",
  });
  expect(res.status).toBe(404);
  expect(res.headers.get("etag")).toBeNull();
});
