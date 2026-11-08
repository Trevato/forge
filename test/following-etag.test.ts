/** GET …/following carries an ETag and answers a repeat with 304 (#9180). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo, forkRepo, updateRepoSettings } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { severChain } from "../src/spawn/chain.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let aliceTok = "";
let bobTok = "";
let carolTok = "";
let upstream: Repo;
const FORK = "/api/v1/repos/bob/up/following";
const CHAIN = FORK;
const get = (path: string, tok: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${tok}`, ...headers } });
const tagOf = async (path: string, tok: string) => {
  const res = await get(path, tok);
  expect(res.status).toBe(200);
  await res.text();
  return res.headers.get("etag")!;
};
const moved = async (path: string, tok: string, tag: string) => {
  const res = await get(path, tok, { "if-none-match": tag });
  expect(res.status).toBe(200);
  const next = res.headers.get("etag")!;
  expect(next).not.toBe(tag);
  await res.text();
  return next;
};
const commit = (who: User, repo: Repo, path: string) =>
  commitToBranch(app, who, repo, { message: path, files: [{ path, content: path }] });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-following-etag-"));
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
  alice = await mk("alice", true);
  bob = await mk("bob", false);
  const carol = await mk("carol", false);
  promote(app.db, alice, bob, carol);
  const up = await createRepo(app, alice, { name: "up", visibility: "public" });
  if (!up.ok) throw new Error("repo");
  upstream = up.value;
  await commit(alice, upstream, "one.txt");
  const fork = await forkRepo(app, bob, upstream);
  if (!fork.ok) throw new Error(JSON.stringify(fork.error));
  await Bun.write(
    join(dataDir, "parent.json"),
    JSON.stringify({
      forgeCode: { repo: "bob/up", upstream: "root/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
    }),
  );
  aliceTok = createToken(app.db, alice.id, "a", "ro").token;
  bobTok = createToken(app.db, bob.id, "b", "ro").token;
  carolTok = createToken(app.db, carol.id, "c", "ro").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a weak tag over the body, private no-cache, vary", async () => {
  const res = await get(FORK, bobTok);
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toMatch(/^W\/"/);
  expect(res.headers.get("cache-control")).toBe("private, no-cache");
  expect(res.headers.get("vary")).toContain("authorization, cookie");
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(((await res.json()) as { parent: string }).parent).toBe("alice/up");
});

test("a repeat is a bodiless 304 with the same headers and the floor", async () => {
  const tag = await tagOf(FORK, bobTok);
  const again = await get(FORK, bobTok, { "if-none-match": tag });
  expect(again.status).toBe(304);
  expect(again.headers.get("etag")).toBe(tag);
  expect(again.headers.get("cache-control")).toBe("private, no-cache");
  expect(again.headers.get("vary")).toContain("authorization, cookie");
  expect(again.headers.get("x-content-type-options")).toBe("nosniff");
  expect(again.headers.get("referrer-policy")).not.toBeNull();
  expect(again.headers.get("content-security-policy")).not.toBeNull();
  expect(await again.text()).toBe("");
});

test("a push to the fork and a push to the parent each move the tag", async () => {
  let tag = await tagOf(FORK, bobTok);
  const fork = getRepo(app.db, "bob", "up")!;
  await commit(bob, fork, "mine.txt");
  tag = await moved(FORK, bobTok, tag);
  expect((await get(FORK, bobTok, { "if-none-match": tag })).status).toBe(304);
  await commit(alice, upstream, "two.txt");
  tag = await moved(FORK, bobTok, tag);
  expect((await get(FORK, bobTok, { "if-none-match": tag })).status).toBe(304);
});

test("a viewer who cannot see the parent is told a different body, so never shares its tag", async () => {
  const seeing = await get(FORK, bobTok);
  expect(seeing.status).toBe(200);
  const seen = (await seeing.json()) as { parent?: string };
  expect(seen.parent).toBe("alice/up");
  const seeingTag = seeing.headers.get("etag")!;
  const hidden = await updateRepoSettings(app, alice, upstream, { visibility: "private" });
  expect(hidden.ok).toBe(true);
  // The fork stays public: carol reads it, but the parent is gone from her view.
  const blind = await get(FORK, carolTok);
  expect(blind.status).toBe(200);
  const blindTag = blind.headers.get("etag")!;
  const body = (await blind.json()) as { parent?: string };
  expect(body.parent).toBeUndefined();
  expect(blindTag).not.toBe(seeingTag);
  // Alice still sees the parent, and her tag is not carol's.
  const alices = await get(FORK, aliceTok);
  expect(alices.status).toBe(200);
  expect(((await alices.json()) as { parent?: string }).parent).toBe("alice/up");
  expect(alices.headers.get("etag")).not.toBe(blindTag);
  // Carol's tag does not buy alice a 304.
  expect((await get(FORK, aliceTok, { "if-none-match": blindTag })).status).toBe(200);
});

test("severing the chain moves the tag", async () => {
  const tag = await tagOf(CHAIN, aliceTok);
  expect((await get(CHAIN, aliceTok, { "if-none-match": tag })).status).toBe(304);
  expect((await severChain(app)).ok).toBe(true);
  await moved(CHAIN, aliceTok, tag);
});

test("not_a_fork and other errors carry no tag", async () => {
  const plain = await get("/api/v1/repos/alice/up/following", aliceTok);
  expect(plain.status).toBe(404);
  expect(((await plain.json()) as { error: string }).error).toBe("not_a_fork");
  expect(plain.headers.get("etag")).toBeNull();
  const missing = await get("/api/v1/repos/alice/nope/following", aliceTok);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("etag")).toBeNull();
});
