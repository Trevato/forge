/**
 * The chips: each switches off what it names and nothing else, through the
 * one filter, on the feed API and the pure function alike; saved per viewer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { chipsOf, KIND_CHIPS, noChips, setChip } from "../src/core/feed_chips.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { chipHides } from "../src/feed/chips.ts";
import type { FeedKind } from "../src/feed/items.ts";
import { readFeed } from "../src/feed/feed.ts";
import { feedJs } from "../src/web/studio/feed.ts";
import { promote } from "./helpers/members.ts";

const ALL: FeedKind[] = [
  "run", "ask", "pull", "decision", "map", "cost", "tell", "reply", "look", "milestone", "choose", "release",
];
const only = (kind: (typeof KIND_CHIPS)[number]) => ({ kinds: new Set([kind]), people: new Set<string>() });

describe("the filter", () => {
  test("a kind chip hides the kinds it names and no others", () => {
    const hidden = (chip: (typeof KIND_CHIPS)[number]) =>
      ALL.filter((kind) => chipHides(only(chip), { kind, actorId: null })).sort();
    expect(hidden("reviews")).toEqual(["pull"]);
    expect(hidden("decisions")).toEqual(["choose", "decision"]);
    expect(hidden("crew")).toEqual(["look", "reply", "tell"]);
    expect(hidden("releases")).toEqual(["release"]);
    expect(ALL.filter((kind) => chipHides(noChips, { kind, actorId: "u" }))).toEqual([]);
  });

  test("a person chip hides that person alone, whatever the kind", () => {
    const chips = { kinds: new Set<never>(), people: new Set(["u1"]) };
    expect(chipHides(chips, { kind: "run", actorId: "u1" })).toBe(true);
    expect(chipHides(chips, { kind: "run", actorId: "u2" })).toBe(false);
    expect(chipHides(chips, { kind: "run", actorId: null })).toBe(false);
  });
});

describe("the chips of a forge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let carol: User;
  let aliceToken: string;
  let bobToken: string;
  let repo: Repo;

  const emit = (kind: string, actor: User, payload = {}) =>
    app.bus.append({ kind, repoId: repo.id, actorId: actor.id, payload });
  const kinds = (viewer: User) => readFeed(app.db, viewer).items.map((i) => i.kind).sort();
  const call = (token: string, method: string, path: string, data?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-chips-"));
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
    carol = await mk("carol");
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    const r = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    repo = r.value;
    emit("run.finished", alice, { kind: "deploy", state: "ok", summary: "up", runId: "r1" });
    emit("look.taken", alice, {});
    emit("app.serving", alice, {});
    emit("pull.merged", carol, { number: 1 });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the feed names each kind before any chip", () => {
    expect(kinds(bob)).toEqual(["look", "pull", "release", "run"]);
  });

  test("each kind chip removes what it names and nothing else", () => {
    const base = kinds(bob);
    for (const [chip, gone] of [
      ["reviews", "pull"],
      ["crew", "look"],
      ["releases", "release"],
    ] as const) {
      setChip(app.db, bob.id, { kind: "kind", value: chip }, true);
      expect(kinds(bob)).toEqual(base.filter((k) => k !== gone));
      setChip(app.db, bob.id, { kind: "kind", value: chip }, false);
      expect(kinds(bob)).toEqual(base);
    }
  });

  test("a person chip removes that person's posts and no one else's", () => {
    setChip(app.db, bob.id, { kind: "person", value: carol.id }, true);
    expect(kinds(bob)).toEqual(["look", "release", "run"]);
    setChip(app.db, bob.id, { kind: "person", value: carol.id }, false);
    expect(kinds(bob)).toHaveLength(4);
  });

  test("chips are the viewer's own", () => {
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, true);
    expect(kinds(alice)).toContain("look");
    expect(chipsOf(app.db, alice.id).kinds.size).toBe(0);
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, false);
  });

  test("the API validates, saves and applies to /api/v1/feed", async () => {
    expect((await fetch(`${servers.url}/api/v1/feed/chips`)).status).toBe(401);
    expect((await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: "nope", hidden: true })).status).toBe(422);
    expect((await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: "crew" })).status).toBe(422);
    expect((await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "x", value: "crew", hidden: true })).status).toBe(422);
    expect((await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "person", value: "nobody", hidden: true })).status).toBe(404);
    const set = await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: "releases", hidden: true });
    expect(await set.json()).toEqual({ kinds: ["releases"], people: [] });
    const person = await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "person", value: "carol", hidden: true });
    expect(await person.json()).toEqual({ kinds: ["releases"], people: ["carol"] });
    const feed = (await (await call(bobToken, "GET", "/api/v1/feed")).json()) as { items: { kind: string }[] };
    expect(feed.items.map((i) => i.kind).sort()).toEqual(["look", "run"]);
    // Alice's feed is untouched, and a chip comes back off.
    const mine = (await (await call(aliceToken, "GET", "/api/v1/feed")).json()) as { items: unknown[] };
    expect(mine.items).toHaveLength(4);
    await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: "releases", hidden: false });
    await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "person", value: "carol", hidden: false });
    expect(kinds(bob)).toHaveLength(4);
  });

  test("a browser session's cross-origin chip is refused", async () => {
    const session = createSession(app.db, bob.id);
    const res = await fetch(`${servers.url}/api/v1/feed/chips`, {
      method: "POST",
      headers: { origin: "http://evil.example", cookie: `forge_session=${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "kind", value: "crew", hidden: true }),
    });
    expect(res.status).toBe(403);
    expect(chipsOf(app.db, bob.id).kinds.size).toBe(0);
  });

  test("the home draws the chips, pressed unless switched off", async () => {
    const session = createSession(app.db, bob.id);
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, true);
    const page = await (await fetch(`${servers.url}/feed`, { headers: { cookie: `forge_session=${session.token}` } })).text();
    expect(page).toContain('data-value="crew"');
    expect(page).toMatch(/data-chip="kind"\s+data-value="crew"\s+aria-pressed="false"/);
    expect(page).toMatch(/data-chip="kind"\s+data-value="reviews"\s+aria-pressed="true"/);
    expect(page).toMatch(/data-chip="person"\s+data-value="alice"/);
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, false);
  });

  test("a pressed chip refreshes the region in place and says when it failed", async () => {
    const handler = feedJs.slice(feedJs.indexOf("function chip(c)"), feedJs.indexOf("feed.addEventListener('click'"));
    expect(handler).not.toContain("location.reload");
    expect(handler).not.toMatch(/b\.message|b\.error|\.statusText/);
    expect(handler).toContain("Sign in again");
    expect(handler).toContain("/live/feed");
    expect(handler).toContain("aria-pressed");
    expect(feedJs).toContain("problem");
    const session = createSession(app.db, bob.id);
    const cookie = { cookie: `forge_session=${session.token}` };
    await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: "crew", hidden: true });
    const region = await (await fetch(`${servers.url}/live/feed`, { headers: cookie })).text();
    expect(region).toMatch(/data-chip="kind"\s+data-value="crew"\s+aria-pressed="false"/);
    expect(region).not.toContain('data-kind="look"');
    await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: "crew", hidden: false });
    const back = await (await fetch(`${servers.url}/live/feed`, { headers: cookie })).text();
    expect(back).toMatch(/data-chip="kind"\s+data-value="crew"\s+aria-pressed="true"/);
    expect(back).toContain('data-kind="look"');
  });

  test("MCP feed applies the saved filter and takes the same filter as arguments", async () => {
    const tool = (token: string, name: string, args: unknown = {}) =>
      mcpTool(servers.url, token, name, args);
    const kindsVia = async (args: unknown = {}) =>
      (((await tool(bobToken, "feed", args)) as any).value.items as { kind: string }[]).map((i) => i.kind).sort();
    expect(await kindsVia()).toEqual(["look", "pull", "release", "run"]);
    expect(await kindsVia({ hide_kinds: ["releases"] })).toEqual(["look", "pull", "run"]);
    expect(await kindsVia({ hide_people: ["carol"] })).toEqual(["look", "release", "run"]);
    // Saved, it applies by default; given, the arguments replace it.
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, true);
    expect(await kindsVia()).toEqual(["pull", "release", "run"]);
    expect(await kindsVia({ hide_kinds: [] })).toEqual(["look", "pull", "release", "run"]);
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, false);
    expect(((await tool(bobToken, "feed", { hide_kinds: ["x"] })) as any).error).toContain("hide_kinds");
    expect(((await tool(bobToken, "feed", { hide_people: [5] })) as any).error).toContain("hide_people");
  });

  test("every drawn kind chip shows what pressing it takes off the page, and pressing it changes the posts", async () => {
    const cookie = { cookie: `forge_session=${createSession(app.db, bob.id).token}` };
    const region = async () => await (await fetch(`${servers.url}/live/feed`, { headers: cookie })).text();
    const posts = (html: string) => [...html.matchAll(/data-item="[^"]*"[^>]*data-kind="(\w+)"/g)].map((m) => m[1]!);
    const drawn = (html: string) =>
      [...html.matchAll(/data-chip="kind"\s+data-value="(\w+)"\s+aria-pressed="true"\s*>([^<]*)</g)].map((m) => [m[1]!, m[2]!.trim()] as const);
    const before = await region();
    const chips = drawn(before);
    // Nothing decided on this page, so no Decisions chip; the others carry a count.
    expect(chips.map(([k]) => k).sort()).toEqual(["crew", "releases", "reviews"]);
    expect(chips.map(([, label]) => label).sort()).toEqual(["Crew words 1", "Pull requests 1", "Releases 1"]);
    for (const [chip] of chips) {
      const had = posts(before);
      await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: chip, hidden: true });
      const after = await region();
      expect(posts(after).length).toBe(had.length - 1);
      expect(after).toMatch(new RegExp(`data-value="${chip}"\\s+aria-pressed="false"`));
      await call(bobToken, "POST", "/api/v1/feed/chips", { kind: "kind", value: chip, hidden: false });
    }
    expect(posts(await region())).toEqual(posts(before));
  });

  test("a count is the posts drawn of its kind, whatever asks the home pins aside", async () => {
    const cookie = { cookie: `forge_session=${createSession(app.db, alice.id).token}` };
    emit("pull.opened", carol, { number: 2, title: "Wait for me" });
    const page = await (await fetch(`${servers.url}/live/feed`, { headers: cookie })).text();
    const drawnPulls = [...page.matchAll(/data-item="[^"]*"[^>]*data-kind="pull"/g)].length;
    expect(page).toMatch(new RegExp(`Pull requests ${drawnPulls}\\s*<`));
  });
});
