/**
 * The timeline pages by `before=<cursor>` (`feed/timeline.ts`): a page costs
 * the page whatever its depth, an arrival between two requests neither
 * repeats nor skips a post, and a cursor only names a place to start.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import type { Repo } from "../src/core/repos.ts";
import { muteRepo } from "../src/core/interactions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { parseBefore, readTimeline } from "../src/feed/timeline.ts";
import { promote } from "./helpers/members.ts";

describe("the feed pages by cursor", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceToken: string;
  let bobToken: string;
  let bobCookie: string;
  let open: Repo;
  let secret: Repo;
  const post = (repo: Repo, n: number) =>
    app.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: alice.id, payload: { number: n } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-feed-cursor-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    await mk("root", true);
    alice = await mk("alice");
    bob = await mk("bob");
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const o = await createRepo(app, alice, { name: "open", visibility: "public" });
    const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!o.ok || !s.ok) throw new Error("repos");
    open = o.value;
    secret = s.value;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (token: string, path: string) =>
    fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const numbers = (items: { link: string }[]) => items.map((i) => Number(i.link.split("/").pop()));

  test("an arrival between page one and page two repeats nothing and skips nothing", async () => {
    // Equal timestamps on purpose: a burst in one millisecond is ordered by the log, not the clock.
    for (let n = 1; n <= 30; n++) post(open, n);
    const one = (await (await api(aliceToken, "/api/v1/feed?before=now&limit=10")).json()) as {
      items: { link: string }[];
      next_cursor: string | null;
    };
    expect(numbers(one.items)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
    for (let n = 31; n <= 35; n++) post(open, n);
    const two = (await (await api(aliceToken, `/api/v1/feed?before=${one.next_cursor}&limit=10`)).json()) as {
      items: { link: string }[];
      next_cursor: string | null;
    };
    expect(numbers(two.items)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
    const rest = readTimeline(app.db, alice, { before: two.next_cursor!, limit: 50 });
    expect(numbers(rest.items)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(rest.next_cursor).toBeNull();
  });

  test("a malformed or tampered cursor is a 422, and a borrowed one reads nothing hidden", async () => {
    for (const bad of ["abc", "'; DROP TABLE event;--", "x".repeat(200), "Z".repeat(26), "1|event:a"]) {
      const res = await api(bobToken, `/api/v1/feed?before=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(422);
    }
    expect((await api(bobToken, "/api/v1/feed?before=now&cursor=1|event:a")).status).toBe(422);
    // Alice's private event id, in Bob's hands: it names a place, and Bob still reads only what he may.
    const hidden = post(secret, 999);
    post(open, 1000);
    const res = await api(bobToken, `/api/v1/feed?before=${hidden.id}&limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { app: string }[] };
    expect(body.items.every((i) => i.app === "alice/open")).toBe(true);
    const all = readTimeline(app.db, bob, { limit: 50 });
    expect(all.items.some((i) => i.app === "alice/secret")).toBe(false);
    expect(parseBefore("now")).toEqual({ id: undefined });
    expect(parseBefore(hidden.id)).toEqual({ id: hidden.id });
  });

  test("the 50th page reads the same rows as the first, from the event index", () => {
    app.db.transaction(() => {
      for (let n = 0; n < 5000; n++) post(open, 2000 + n);
    })();
    // The work, not the clock: every statement a deep page runs, with its plan.
    const sqls: string[] = [];
    const original = app.db.query.bind(app.db);
    (app.db as unknown as { query: unknown }).query = (sql: string) => {
      sqls.push(sql);
      return original(sql);
    };
    let first = { items: [] as { id: string }[], next_cursor: null as string | null };
    let deep = first;
    try {
      let before: string | undefined;
      for (let p = 0; p < 50; p++) {
        if (p === 49) sqls.length = 0;
        const page = readTimeline(app.db, alice, { limit: 20, ...(before === undefined ? {} : { before }) });
        if (p === 0) first = page;
        deep = page;
        before = page.next_cursor ?? undefined;
      }
    } finally {
      (app.db as unknown as { query: unknown }).query = original;
    }
    expect(first.items.length).toBe(20);
    expect(deep.items.length).toBe(20);
    expect(deep.next_cursor).not.toBeNull();
    const reads = sqls.filter((sql) => /FROM event JOIN repo/.test(sql));
    expect(reads.length).toBe(1); // one batch of 100 serves a 20-post page, however deep
    for (const sql of reads) {
      const n = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = original(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: n }, () => "x"))
        .map((r) => (r as { detail: string }).detail)
        .join("\n");
      expect(plan).not.toContain("TEMP B-TREE");
      expect(plan).not.toMatch(/SCAN event(?! USING)/);
    }
    const seen = new Set<string>();
    let before: string | undefined;
    for (let p = 0; p < 50; p++) {
      const page = readTimeline(app.db, alice, { limit: 20, ...(before === undefined ? {} : { before }) });
      for (const i of page.items) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      before = page.next_cursor ?? undefined;
    }
    expect(seen.size).toBe(1000);
  });

  test("the older link works without script", async () => {
    const res = await fetch(`${servers.url}/feed?before=now`, { headers: { cookie: bobCookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const href = /href="(\/feed\?before=[0-9a-z]{26})">Older posts/.exec(text);
    expect(href).not.toBeNull();
    const next = await fetch(`${servers.url}${href![1]}`, { headers: { cookie: bobCookie } });
    expect(next.status).toBe(200);
    expect(await next.text()).toContain('data-item="event:');
    expect((await fetch(`${servers.url}/feed?before=garbage`, { headers: { cookie: bobCookie } })).status).toBe(200);
  });

  const mcp = async (token: string, args: object) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed", arguments: args } }),
    });
    const out = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: out.result.isError === true, text: out.result.content[0]!.text };
  };

  test("MCP feed takes before, pages by it, and refuses before with cursor or garbage", async () => {
    const one = await mcp(aliceToken, { before: "now", limit: 5 });
    expect(one.error).toBe(false);
    const page = JSON.parse(one.text) as { items: { id: string }[]; next_cursor: string };
    expect(page.items).toHaveLength(5);
    const two = JSON.parse((await mcp(aliceToken, { before: page.next_cursor, limit: 5 })).text) as { items: { id: string }[] };
    expect(two.items).toHaveLength(5);
    expect(two.items.some((i) => page.items.some((j) => j.id === i.id))).toBe(false);
    expect((await mcp(aliceToken, { before: "now", cursor: "1|event:a" })).error).toBe(true);
    expect((await mcp(aliceToken, { before: "garbage" })).error).toBe(true);
  });

  test("a timeline page answers 304 to its own ETag and a different one to another cursor", async () => {
    const url = "/api/v1/feed?before=now&limit=5";
    const res = await api(aliceToken, url);
    const tag = res.headers.get("etag");
    expect(tag).not.toBeNull();
    const again = await fetch(`${servers.url}${url}`, { headers: { authorization: `Bearer ${aliceToken}`, "if-none-match": tag! } });
    expect(again.status).toBe(304);
    const { next_cursor } = (await res.json()) as { next_cursor: string };
    const other = await api(aliceToken, `/api/v1/feed?before=${next_cursor}&limit=5`);
    expect(other.headers.get("etag")).not.toBe(tag);
    const stale = await fetch(`${servers.url}/api/v1/feed?before=${next_cursor}&limit=5`, { headers: { authorization: `Bearer ${aliceToken}`, "if-none-match": tag! } });
    expect(stale.status).toBe(200);
  });

  test("a page whose filters hide a whole batch is short, carries a cursor, and the page still links on", async () => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username: "carol", allowReserved: true,
      email: "carol@forge.local", password: "a-good-passphrase", adminIfFirst: false,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    const carol = r.value;
    const noisy = await createRepo(app, alice, { name: "noisy", visibility: "public" });
    if (!noisy.ok) throw new Error("repo");
    app.db.transaction(() => {
      for (let n = 0; n < 600; n++) post(noisy.value, 9000 + n);
    })();
    muteRepo(app.db, carol.id, noisy.value.id);
    const page = readTimeline(app.db, carol, { limit: 5 });
    expect(page.items).toEqual([]);
    expect(page.next_cursor).not.toBeNull();
    const cookie = `forge_session=${createSession(app.db, carol.id).token}`;
    const html = await (await fetch(`${servers.url}/feed?before=now`, { headers: { cookie } })).text();
    expect(html).toContain(`/feed?before=${page.next_cursor}">Older posts`);
    // Following it reaches the posts the mute left.
    const on = await (await fetch(`${servers.url}/feed?before=${page.next_cursor}`, { headers: { cookie } })).text();
    expect(on).toContain('data-item="event:');
  });
});
