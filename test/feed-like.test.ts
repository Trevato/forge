/**
 * A like on a feed item (#7751, #10389): a ledger row (who, what, when), idempotent;
 * unlike is a new row; one person counts once; an item the viewer cannot read is a 404.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { ledgerCount, likeLedger, setLike } from "../src/feed/likes.ts";
import { createSession } from "../src/core/sessions.ts";
import { feedCard, feedJs } from "../src/web/studio/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let aliceTok: string;
let bobTok: string;
let openEvent: string;
let secretEvent: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-like-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  await mk("founder", true);
  alice = await mk("alice");
  bob = await mk("bob");
  aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
  bobTok = createToken(app.db, bob.id, "rw", "rw").token;
  const o = await createRepo(app, alice, { name: "open", visibility: "public" });
  const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
  if (!o.ok || !s.ok) throw new Error("repos");
  for (const [repo, summary] of [[o.value, "up"], [s.value, "boom"]] as const)
    app.bus.append({
      kind: "run.finished",
      repoId: repo.id,
      actorId: alice.id,
      payload: { kind: "deploy", state: "ok", summary, runId: `r-${summary}` },
    });
  const items = readFeed(app.db, alice).items.filter((i) => i.id.startsWith("event:"));
  openEvent = items.find((i) => i.app === "alice/open")!.id;
  secretEvent = items.find((i) => i.app === "alice/secret")!.id;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const send = (tok: string, item: string, kind: string) =>
  fetch(`${servers.url}/api/v1/feed/interactions`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ item, kind }),
  });
const like = (tok: string, item: string) => send(tok, item, "liked");
const unlike = (tok: string, item: string) => send(tok, item, "unliked");
const ledgerRows = (item: string) =>
  app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM feed_signal WHERE item_id = ?1").get(item)!.n;
const stateOf = (who: User, item: string) => {
  const found = readFeed(app.db, who).items.find((i) => i.id === item)!;
  return { likes: found.likes ?? 0, liked: found.liked ?? false };
};

describe("a like", () => {
  test("is one ledger row, a repeat is a no-op, unlike is a new row, and the count is the ledger's", async () => {
    const check = (likes: number, liked: boolean) => {
      expect(stateOf(bob, openEvent)).toEqual({ likes, liked });
      expect(ledgerCount(app.db, openEvent)).toBe(likes);
    };
    check(0, false);
    const first = await like(bobTok, openEvent);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ likes: 1, liked: true });
    expect(ledgerRows(openEvent)).toBe(1);
    check(1, true);
    const again = await like(bobTok, openEvent);
    expect(await again.json()).toEqual({ likes: 1, liked: true });
    expect(ledgerRows(openEvent)).toBe(1);
    check(1, true);
    const off = await unlike(bobTok, openEvent);
    expect(await off.json()).toEqual({ likes: 0, liked: false });
    // History is kept: the like stands, and the unlike is a second row.
    expect(ledgerRows(openEvent)).toBe(2);
    check(0, false);
    expect(await (await unlike(bobTok, openEvent)).json()).toEqual({ likes: 0, liked: false });
    expect(ledgerRows(openEvent)).toBe(2);
    await like(bobTok, openEvent);
    expect(ledgerRows(openEvent)).toBe(3);
    check(1, true);
    const rows = likeLedger(app.db, openEvent).rows;
    expect(rows.map((r) => [r.who, r.act])).toEqual([["bob", "like"], ["bob", "unlike"], ["bob", "like"]].reverse());
    expect(rows[0]!.at).toMatch(/^\d{4}-/);
    await unlike(bobTok, openEvent);
  });

  test("is read back from the API ledger by anyone who may see the item", async () => {
    await like(aliceTok, openEvent);
    const res = await fetch(`${servers.url}/api/v1/feed/likes?item=${encodeURIComponent(openEvent)}`, {
      headers: { authorization: `Bearer ${bobTok}` },
    });
    const body = (await res.json()) as { ledger: { who: string; act: string }[] };
    expect(body.ledger.filter((r) => r.who === "alice").map((r) => r.act)).toEqual(["like"]);
    const hidden = await fetch(`${servers.url}/api/v1/feed/likes?item=${encodeURIComponent(secretEvent)}`, {
      headers: { authorization: `Bearer ${bobTok}` },
    });
    expect(hidden.status).toBe(404);
    await unlike(aliceTok, openEvent);
  });

  test("from an anonymous caller is a 401 naming the sign-in route, and writes nothing", async () => {
    const before = ledgerRows(openEvent);
    const res = await fetch(`${servers.url}/api/v1/feed/interactions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: openEvent, kind: "liked" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toContain("/signin");
    expect(ledgerRows(openEvent)).toBe(before);
  });

  test("with a read-only token is refused", async () => {
    const ro = createToken(app.db, bob.id, "ro", "ro").token;
    expect((await like(ro, openEvent)).status).toBe(403);
  });

  test("counts each person once, and shows each viewer their own", async () => {
    await like(bobTok, openEvent);
    await like(aliceTok, openEvent);
    await like(aliceTok, openEvent);
    expect(stateOf(bob, openEvent)).toEqual({ likes: 2, liked: true });
    expect(stateOf(alice, openEvent)).toEqual({ likes: 2, liked: true });
    await unlike(bobTok, openEvent);
    expect(stateOf(bob, openEvent)).toEqual({ likes: 1, liked: false });
    expect(stateOf(alice, openEvent)).toEqual({ likes: 1, liked: true });
    expect(ledgerCount(app.db, openEvent)).toBe(1);
    await unlike(aliceTok, openEvent);
  });

  test("on an item the viewer cannot read is a 404 and leaves no row", async () => {
    expect((await like(bobTok, secretEvent)).status).toBe(404);
    expect((await like(bobTok, "event:nothing-here")).status).toBe(404);
    expect(app.db.query("SELECT 1 FROM feed_like WHERE item_id = ?1").get(secretEvent)).toBeNull();
    expect(ledgerRows(secretEvent)).toBe(0);
  });
});

describe("the Like button", () => {
  const base = {
    id: "event:x", kind: "run", app: "alice/open", actor: "alice", at: "2026-01-01T00:00:00Z",
    link: "/alice/open", what: "Deployed", reason: "because you own alice/open", score: 1,
  } as const;

  test("is a form posting back to the feed, with the count", () => {
    const out = String(feedCard({ ...base, likes: 3, liked: false } as never));
    expect(out).toContain('method="post" action="/feed/like"');
    expect(out).toContain('name="item" value="event:x"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain("<span data-likes>3</span>");
  });

  test("a post nobody likes still draws the button, at zero", () => {
    const out = String(feedCard({ ...base } as never));
    expect(out).toContain("<span data-likes>0</span>");
  });

  test("without a script the form posts back to the feed", async () => {
    const res = await fetch(`${servers.url}/feed/like`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${bobTok}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ item: openEvent, back: "/feed" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/feed");
    expect(stateOf(bob, openEvent).liked).toBe(true);
    const gone = await fetch(`${servers.url}/feed/like`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobTok}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ item: secretEvent }).toString(),
    });
    expect(gone.status).toBe(404);
  });
});

describe("the doors", () => {
  beforeEach(() => void app.db.run("DELETE FROM feed_like"));
  const cookie = () => `forge_session=${createSession(app.db, bob.id).token}`;
  const form = (headers: Record<string, string>, item = openEvent, act = "like") =>
    fetch(`${servers.url}/feed/like`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ item, app: "alice/open", act }).toString(),
    });
  const likesNow = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM feed_like WHERE item_id = ?1").get(openEvent)!.n;

  test("GET /api/v1/feed carries likes and liked for the viewer, and omits them where nobody likes", async () => {
    await like(aliceTok, openEvent);
    await like(aliceTok, openEvent);
    const get = async (tok: string) =>
      ((await (await fetch(`${servers.url}/api/v1/feed`, { headers: { authorization: `Bearer ${tok}` } })).json()) as {
        items: { id: string; likes?: number; liked?: boolean }[];
      }).items.find((i) => i.id === openEvent)!;
    expect(await get(aliceTok)).toMatchObject({ likes: 1, liked: true });
    expect(await get(bobTok)).toMatchObject({ likes: 1, liked: false });
    await unlike(aliceTok, openEvent);
    const none = await get(bobTok);
    expect(none.likes).toBeUndefined();
    expect(none.liked).toBeUndefined();
  });

  test("a cross-origin POST /feed/like is refused and likes nothing", async () => {
    const before = likesNow();
    const res = await form({ cookie: cookie(), origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(likesNow()).toBe(before);
  });

  test("a signed-out POST /feed/like is sent to sign in and likes nothing", async () => {
    const before = likesNow();
    const res = await form({ origin: servers.url });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/signin");
    expect(likesNow()).toBe(before);
  });

  test("asked for JSON, /feed/like answers the new count", async () => {
    const on = await form({ authorization: `Bearer ${bobTok}`, accept: "application/json" }, openEvent, "like");
    expect(await on.json()).toMatchObject({ likes: 1, liked: true });
    const repeat = await form({ authorization: `Bearer ${bobTok}`, accept: "application/json" }, openEvent, "like");
    expect(await repeat.json()).toMatchObject({ likes: 1, liked: true });
    const off = await form({ authorization: `Bearer ${bobTok}`, accept: "application/json" }, openEvent, "unlike");
    expect(await off.json()).toMatchObject({ likes: 0, liked: false });
  });
});

describe("the live script", () => {
  // The page's own `like`, run against a stub form and a fetch that answers as told.
  const run = (answer: () => Promise<unknown>) => {
    const start = feedJs.indexOf("function like(form, e) {");
    const end = feedJs.indexOf("\n  }\n", start) + 4;
    const state = { pressed: "false", count: "2", painted: 0, read: () => "" };
    const btn = {
      getAttribute: () => state.pressed,
      setAttribute: (_: string, v: string) => void (state.pressed = v),
    };
    const count = {
      get textContent() { return state.count; },
      set textContent(v: string) { state.count = v; },
    };
    const f = {
      querySelector: (q: string) => (q === "button" ? btn : count),
      getAttribute: () => "/feed/like",
    };
    const script = feedJs.slice(start, end);
    const made = new Function(
      "fetch", "FormData", "URLSearchParams", "paint",
      `var problem = ''; ${script}; return { like: like, get problem() { return problem; } };`,
    )(answer, function () { return []; }, URLSearchParams, () => void state.painted++) as {
      like: (f: unknown, e: unknown) => void;
      problem: string;
    };
    const like = made.like;
    state.read = () => made.problem;
    like(f, { preventDefault() {} });
    return state;
  };

  test("a refusal puts the button and the count back and says so", async () => {
    const state = run(() => Promise.resolve({ ok: false }));
    expect(state).toMatchObject({ pressed: "true", count: "3" });
    await new Promise((r) => setTimeout(r, 0));
    expect(state).toMatchObject({ pressed: "false", count: "2", painted: 1 });
    expect(state.read()).toContain("The like was not saved");
  });

  test("an answer sets the count the forge gave", async () => {
    const state = run(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ liked: true, likes: 7 }) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(state).toMatchObject({ pressed: "true", count: "7" });
    expect(state.read()).toBe("");
  });
});

describe("one ledger from every door", () => {
  const mcp = async (tok: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed_like", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    try { return JSON.parse(text); } catch { return text; }
  };

  test("the page, the API and the MCP each write a row for their own caller, and the count matches", async () => {
    app.db.run("DELETE FROM feed_like");
    app.db.run("DELETE FROM feed_signal");
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const page = await fetch(`${servers.url}/feed/like`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: servers.url },
      body: new URLSearchParams({ item: openEvent, app: "alice/open", act: "like" }).toString(),
    });
    expect(page.status).toBe(303);
    await like(bobTok, openEvent);
    const founder = createToken(app.db, (app.db.query("SELECT id FROM user WHERE username = 'founder'").get() as { id: string }).id, "rw", "rw").token;
    expect(await mcp(founder, { item: openEvent, act: "like" })).toEqual({ likes: 3, liked: true });
    expect(await mcp(founder, { item: openEvent, act: "like" })).toEqual({ likes: 3, liked: true });
    expect(likeLedger(app.db, openEvent).rows.map((r) => r.who).sort()).toEqual(["alice", "bob", "founder"]);
    expect(stateOf(alice, openEvent).likes).toBe(ledgerCount(app.db, openEvent));
    expect(await mcp(founder, { item: openEvent, act: "unlike" })).toEqual({ likes: 2, liked: false });
    const history = await mcp(founder, { item: openEvent, act: "history" });
    expect(history.ledger.map((r: { who: string; act: string }) => `${r.who}:${r.act}`)).toEqual(["alice:like", "bob:like", "founder:like", "founder:unlike"].reverse());
    expect(stateOf(alice, openEvent).likes).toBe(ledgerCount(app.db, openEvent));
  });

  test("the MCP refuses an unseen item and a bad act, writing nothing", async () => {
    const before = ledgerRows(secretEvent);
    expect(String(await mcp(bobTok, { item: secretEvent, act: "like" }))).toContain("not visible");
    expect(ledgerRows(secretEvent)).toBe(before);
    expect(String(await mcp(bobTok, { item: openEvent, act: "nope" }))).toContain("act is one of");
  });

  test("newest first, a page at a time, with `more` and a `before` cursor, over API and MCP", async () => {
    const e = openEvent;
    app.db.run("DELETE FROM feed_signal WHERE item_id = ?1", [e]);
    app.db.run("DELETE FROM feed_like WHERE item_id = ?1", [e]);
    const repoId = (app.db.query("SELECT id FROM repo WHERE name = 'open'").get() as { id: string }).id;
    for (let i = 0; i < 60; i++) setLike(app.db, bob.id, e, repoId, i % 2 === 0 ? "like" : "unlike");
    const page = likeLedger(app.db, e);
    expect(page.rows).toHaveLength(50);
    expect(page.more).toBe(true);
    expect(page.rows[0]!.seq).toBeGreaterThan(page.rows[49]!.seq);
    const rest = likeLedger(app.db, e, page.rows[49]!.seq);
    expect(rest.rows).toHaveLength(10);
    expect(rest.more).toBe(false);
    expect(rest.rows[0]!.seq).toBeLessThan(page.rows[49]!.seq);
    const founder = createToken(app.db, (app.db.query("SELECT id FROM user WHERE username = 'founder'").get() as { id: string }).id, "rw", "rw").token;
    const mcpRest = await mcp(founder, { item: e, act: "history", before: page.rows[49]!.seq });
    expect(mcpRest.ledger).toHaveLength(10);
    expect(mcpRest.more).toBe(false);
    expect(String(await mcp(founder, { item: e, act: "history", before: "x" }))).toContain("before");
  });

  test("the API takes `before` and refuses a bad one", async () => {
    const get = (q: string) => fetch(`${servers.url}/api/v1/feed/likes?item=${encodeURIComponent(openEvent)}${q}`, { headers: { authorization: `Bearer ${bobTok}` } });
    const all = (await (await get("")).json()) as { ledger: { seq: number }[]; more: boolean };
    expect(all.ledger).toHaveLength(50);
    expect(all.more).toBe(true);
    const older = (await (await get(`&before=${all.ledger[49]!.seq}`)).json()) as { ledger: unknown[]; more: boolean };
    expect(older.ledger).toHaveLength(10);
    expect(older.more).toBe(false);
    expect((await get("&before=abc")).status).toBe(422);
  });
});

describe("like-flooding", () => {
  test("a token that floods likes meets the per-token rate limit, and writes no more than it was let", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-like-rate-"));
    process.env["FORGE_RATE_LIMIT"] = "5";
    const a = createApp({ dataDir: dir, port: 0 });
    const s = await serve(a);
    delete process.env["FORGE_RATE_LIMIT"];
    try {
      const u = await createUser(a.db, { origin: "seed", trusted: true, username: "flood", email: "f@forge.local", password: "a-good-passphrase", adminIfFirst: true });
      if (!u.ok) throw new Error(u.error);
      const tok = createToken(a.db, u.value.id, "rw", "rw").token;
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await fetch(`${s.url}/api/v1/feed/interactions`, {
          method: "POST",
          headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
          body: JSON.stringify({ item: "event:nothing", kind: i % 2 ? "unliked" : "liked" }),
        });
        codes.push(r.status);
      }
      expect(codes.slice(0, 5).every((c) => c === 404)).toBe(true);
      expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    } finally {
      s.stop();
      a.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
