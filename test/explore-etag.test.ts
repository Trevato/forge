/** GET /api/v1/explore carries an ETag and answers a repeat with 304 until something listed changes (#9105). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let tokens: Record<string, string>;
let openId: string;

const get = (who: string | null, etag?: string, path = "/api/v1/explore?q=kind:app") =>
  fetch(`${servers.url}${path}`, {
    headers: {
      ...(who === null ? {} : { authorization: `Bearer ${tokens[who]}` }),
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    },
  });
const tagOf = async (who: string | null, path?: string): Promise<string> => {
  const res = await get(who, undefined, path);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-explore-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, allowReserved: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  await mk("root", true);
  alice = await mk("alice");
  const bob = await mk("bob");
  tokens = { alice: createToken(app.db, alice.id, "t", "rw").token, bob: createToken(app.db, bob.id, "t", "rw").token };
  for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
    const repo = await createRepo(app, alice, { name, visibility });
    if (!repo.ok) throw new Error(String(repo.error));
    const rec = insertApp(app.db, { repoId: repo.value.id, slug: `alice-${name}`, access: visibility });
    if (!rec.ok) throw new Error(rec.error);
    if (name === "open") openId = repo.value.id;
  }
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the explore ETag", () => {
  test("200 carries the tag and headers; a repeat is a 304 that skipped the explore phase", async () => {
    const first = await get(null);
    await first.arrayBuffer();
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"[0-9a-z]+"$/);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    expect(first.headers.get("server-timing")).toContain("explore");
    const again = await get(null, tag);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("server-timing") ?? "").not.toContain("explore");
    expect((await get(null, 'W/"other"')).status).toBe(200);
  });

  test("a like on a listed app makes the next answer a 200 with a new tag", async () => {
    const tag = await tagOf(null);
    app.db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [alice.id, "x-1", openId]);
    const next = await get(null, tag);
    expect(next.status).toBe(200);
    expect(next.headers.get("etag")).not.toBe(tag);
    await next.arrayBuffer();
  });

  test("a visibility change moves the tag", async () => {
    const tag = await tagOf(null);
    app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [openId]);
    const next = await get(null, tag);
    expect(next.status).toBe(200);
    await next.arrayBuffer();
    app.db.run("UPDATE repo SET visibility = 'public' WHERE id = ?1", [openId]);
  });

  test("one viewer's tag never matches another's, nor another line or cursor", async () => {
    await tagOf("alice"); await tagOf("bob"); // first use of a token writes its last-used time
    const a = await tagOf("alice");
    const b = await tagOf("bob");
    const anon = await tagOf(null);
    expect(new Set([a, b, anon]).size).toBe(3);
    expect((await get("bob", a)).status).toBe(200);
    expect((await get(null, a)).status).toBe(200);
    expect((await get("alice", a)).status).toBe(304);
    expect(await tagOf("alice", "/api/v1/explore?q=kind:person")).not.toBe(a);
  });

  test("a bad cursor is a 400 even with If-None-Match: *", async () => {
    const res = await get(null, "*", "/api/v1/explore?q=kind:app&cursor=nonsense");
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    const ok = await get(null, "*");
    expect(ok.status).toBe(304);
  });
});
