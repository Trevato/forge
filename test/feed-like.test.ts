/**
 * A like on a feed item (#7751): one press likes, a second takes it back,
 * one person counts once, and an item the viewer cannot read is a 404.
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

const like = (tok: string, item: string) =>
  fetch(`${servers.url}/api/v1/feed/interactions`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ item, kind: "liked" }),
  });
const stateOf = (who: User, item: string) => {
  const found = readFeed(app.db, who).items.find((i) => i.id === item)!;
  return { likes: found.likes ?? 0, liked: found.liked ?? false };
};

describe("a like", () => {
  test("is recorded, then taken back by the second press", async () => {
    expect(stateOf(bob, openEvent)).toEqual({ likes: 0, liked: false });
    const first = await like(bobTok, openEvent);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ likes: 1, liked: true });
    expect(stateOf(bob, openEvent)).toEqual({ likes: 1, liked: true });
    const second = await like(bobTok, openEvent);
    expect(await second.json()).toEqual({ likes: 0, liked: false });
    expect(stateOf(bob, openEvent)).toEqual({ likes: 0, liked: false });
    // Taking it back deletes the row: nothing is left of it.
    expect(app.db.query("SELECT 1 FROM feed_like WHERE item_id = ?1").get(openEvent)).toBeNull();
  });

  test("counts each person once, and shows each viewer their own", async () => {
    await like(bobTok, openEvent);
    await like(aliceTok, openEvent);
    expect(stateOf(bob, openEvent)).toEqual({ likes: 2, liked: true });
    expect(stateOf(alice, openEvent)).toEqual({ likes: 2, liked: true });
    await like(bobTok, openEvent);
    expect(stateOf(bob, openEvent)).toEqual({ likes: 1, liked: false });
    expect(stateOf(alice, openEvent)).toEqual({ likes: 1, liked: true });
    await like(aliceTok, openEvent);
  });

  test("on an item the viewer cannot read is a 404 and leaves no row", async () => {
    expect((await like(bobTok, secretEvent)).status).toBe(404);
    expect((await like(bobTok, "event:nothing-here")).status).toBe(404);
    expect(app.db.query("SELECT 1 FROM feed_like WHERE item_id = ?1").get(secretEvent)).toBeNull();
  });

  test("cannot be sent as unliked: that is only the second press", async () => {
    const res = await fetch(`${servers.url}/api/v1/feed/interactions`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobTok}`, "content-type": "application/json" },
      body: JSON.stringify({ item: openEvent, kind: "unliked" }),
    });
    expect(res.status).toBe(422);
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
  const form = (headers: Record<string, string>, item = openEvent) =>
    fetch(`${servers.url}/feed/like`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ item, app: "alice/open" }).toString(),
    });
  const likesNow = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM feed_like WHERE item_id = ?1").get(openEvent)!.n;

  test("GET /api/v1/feed carries likes and liked for the viewer, and omits them where nobody likes", async () => {
    await like(aliceTok, openEvent);
    const get = async (tok: string) =>
      ((await (await fetch(`${servers.url}/api/v1/feed`, { headers: { authorization: `Bearer ${tok}` } })).json()) as {
        items: { id: string; likes?: number; liked?: boolean }[];
      }).items.find((i) => i.id === openEvent)!;
    expect(await get(aliceTok)).toMatchObject({ likes: 1, liked: true });
    expect(await get(bobTok)).toMatchObject({ likes: 1, liked: false });
    await like(aliceTok, openEvent);
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
    const on = await form({ authorization: `Bearer ${bobTok}`, accept: "application/json" });
    expect(await on.json()).toMatchObject({ likes: 1, liked: true });
    const off = await form({ authorization: `Bearer ${bobTok}`, accept: "application/json" });
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
