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
import { chipHides } from "../src/feed/chips.ts";
import type { FeedKind } from "../src/feed/items.ts";
import { readFeed } from "../src/feed/feed.ts";

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
        trusted: true,
        username,
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
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
    const page = await (await fetch(`${servers.url}/`, { headers: { cookie: `forge_session=${session.token}` } })).text();
    expect(page).toContain('data-value="crew"');
    expect(page).toMatch(/data-chip="kind"\s+data-value="crew"\s+aria-pressed="false"/);
    expect(page).toMatch(/data-chip="kind"\s+data-value="reviews"\s+aria-pressed="true"/);
    expect(page).toMatch(/data-chip="person"\s+data-value="alice"/);
    setChip(app.db, bob.id, { kind: "kind", value: "crew" }, false);
  });
});
