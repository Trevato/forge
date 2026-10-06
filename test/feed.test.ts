/**
 * The feed: a per-viewer read of the outbox, asks and the ledger, ranked,
 * each item with the sentence that says why. Proven on the ranker's own
 * terms (pure), and end to end on who may see what.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { recordInteraction } from "../src/core/interactions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { Affinity, affinityFor } from "../src/feed/affinity.ts";
import type { Candidate } from "../src/feed/items.ts";
import { readFeed } from "../src/feed/feed.ts";
import { rank } from "../src/feed/rank.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id: `event:${id}`,
  kind: "pull",
  repoId: "r1",
  app: "alice/one",
  actorId: null,
  actor: null,
  at: new Date(NOW - HOUR).toISOString(),
  link: "/alice/one",
  what: "a change shipped",
  urgency: 0,
  ...over,
});

describe("the ranker", () => {
  test("urgency beats affinity beats recency, and says so", () => {
    const aff = new Affinity();
    aff.add("app:liked", "owns", 3, NOW);
    const items = rank(
      [
        cand("fresh", { repoId: "plain", at: new Date(NOW).toISOString() }),
        cand("liked", { repoId: "liked", at: new Date(NOW - 20 * HOUR).toISOString() }),
        cand("ask", {
          repoId: "other",
          kind: "ask",
          urgency: 8,
          what: "one: “x” is green, waiting for your look",
          at: new Date(NOW - 3 * DAY).toISOString(),
        }),
      ],
      aff,
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual(["event:ask", "event:liked", "event:fresh"]);
    expect(items[0]!.reason).toBe("one: “x” is green, waiting for your look");
    expect(items[1]!.reason).toBe("because you own alice/one");
    expect(items[2]!.reason).toBe("a change shipped, just now");
  });

  test("the reason names what you shipped, and when", () => {
    const aff = new Affinity();
    aff.add("app:r1", "shipped", 3, NOW - DAY - HOUR, "Fix the nav");
    const [item] = rank([cand("a")], aff, NOW);
    expect(item!.reason).toBe("because you shipped “Fix the nav” yesterday");
  });

  test("a crew member's news says whose crew", () => {
    const aff = new Affinity();
    aff.add("actor:u1", "crew", 6, NOW);
    const [item] = rank([cand("a", { actorId: "u1", actor: "scout" })], aff, NOW);
    expect(item!.reason).toBe("because scout is on your crew");
  });

  test("one source cannot fill the feed: repeats decay", () => {
    const same = [1, 2, 3, 4].map((n) =>
      cand(`a${n}`, { at: new Date(NOW - n * 60_000).toISOString() }),
    );
    const other = cand("b", {
      repoId: "r2",
      app: "bob/two",
      at: new Date(NOW - 20 * 60_000).toISOString(),
    });
    const ids = rank([...same, other], new Affinity(), NOW).map((i) => i.id);
    expect(ids.indexOf("event:b")).toBeLessThan(ids.indexOf("event:a3"));
    expect(ids[0]).toBe("event:a1");
  });

  test("placed scores never rise, so a cursor can resume", () => {
    const items = rank(
      [1, 2, 3, 4, 5].map((n) => cand(`x${n}`, { at: new Date(NOW - n * HOUR).toISOString() })),
      new Affinity(),
      NOW,
    );
    for (let i = 1; i < items.length; i++)
      expect(items[i]!.score).toBeLessThanOrEqual(items[i - 1]!.score);
  });

  test("a dismissal weighs more than an opening: negatives are strong", () => {
    const liked = new Affinity();
    liked.add("app:r1", "opened", 1, NOW);
    const burned = new Affinity();
    burned.add("app:r1", "opened", 1, NOW);
    burned.add("app:r1", "dismissed", -4, NOW);
    expect(burned.app("r1").score).toBeLessThan(0);
    const [a] = rank([cand("a")], liked, NOW);
    const [b] = rank([cand("a")], burned, NOW);
    expect(b!.score).toBeLessThan(a!.score);
  });
});

describe("the feed of a forge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceToken: string;
  let bobToken: string;
  let secretRepo: Repo;
  let openRepo: Repo;
  const emit = (repo: Repo, kind: string, actor: User, payload = {}) =>
    app.bus.append({ kind, repoId: repo.id, actorId: actor.id, payload });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-feed-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, { trusted: true,
        username,
        // Fixtures may name an account after a reserved word on purpose.
        allowReserved: true,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    // The first account is a site admin, who sees everything; neither of
    // the two people under test is.
    await mk("root", true);
    alice = await mk("alice");
    bob = await mk("bob");
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    bobToken = createToken(app.db, bob.id, "t", "rw").token;
    const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
    const o = await createRepo(app, alice, { name: "open", visibility: "public" });
    if (!s.ok || !o.ok) throw new Error("repos");
    secretRepo = s.value;
    openRepo = o.value;
    emit(secretRepo, "run.finished", alice, { kind: "deploy", state: "failed", summary: "boom", runId: "r" });
    emit(openRepo, "run.finished", alice, { kind: "deploy", state: "ok", summary: "up", runId: "r2" });
    emit(openRepo, "webhook.created", alice, { url: "https://hooks.example.test/s3cret" });
    emit(openRepo, "issue.blocked", alice, { number: 2, blockedBy: 1 });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (token: string, path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  test("no leak across viewers: a private repo and configuration stay out", () => {
    const mine = readFeed(app.db, alice).items;
    expect(mine.some((i) => i.app === "alice/secret")).toBe(true);
    const theirs = readFeed(app.db, bob).items;
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((i) => i.app === "alice/open")).toBe(true);
    expect(JSON.stringify(theirs)).not.toContain("s3cret");
    expect(theirs.map((i) => i.kind).sort()).toEqual(["map", "run"]);
  });

  test("items are plain data with a reason and a link", () => {
    for (const i of readFeed(app.db, alice).items) {
      expect(i.id).toMatch(/^[a-z]+:/);
      expect(i.link.startsWith("/alice/")).toBe(true);
      expect(i.reason.length).toBeGreaterThan(5);
      expect(Date.parse(i.at)).not.toBeNaN();
    }
  });

  test("GET /api/v1/feed needs a viewer, validates, and pages by cursor", async () => {
    expect((await fetch(`${servers.url}/api/v1/feed`)).status).toBe(401);
    expect((await api(aliceToken, "/api/v1/feed?limit=0")).status).toBe(422);
    expect((await api(aliceToken, "/api/v1/feed?cursor=x")).status).toBe(422);
    const first = (await (await api(aliceToken, "/api/v1/feed?limit=1")).json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const seen = [first.items[0]!.id];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = (await (
        await api(aliceToken, `/api/v1/feed?limit=1&cursor=${encodeURIComponent(cursor)}`)
      ).json()) as typeof first;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(readFeed(app.db, alice).items.map((i) => i.id));
  });

  test("an interaction is validated, and cannot name what the viewer cannot see", async () => {
    const post = (token: string, data: unknown, headers = {}) =>
      api(token, "/api/v1/feed/interactions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(data),
      });
    const secretEvent = readFeed(app.db, alice).items.find((i) => i.app === "alice/secret")!;
    expect((await post(bobToken, { item: secretEvent.id, kind: "opened" })).status).toBe(404);
    expect((await post(aliceToken, { item: secretEvent.id, kind: "bogus" })).status).toBe(422);
    expect((await post(aliceToken, { item: "../x", kind: "opened" })).status).toBe(422);
    expect((await post(aliceToken, { item: secretEvent.id, kind: "opened" })).status).toBe(201);
    // Configuration events are the admins' even where the repo is public.
    const hook = app.db
      .query<{ id: string }, []>("SELECT id FROM event WHERE kind = 'webhook.created'")
      .get()!;
    expect((await post(bobToken, { item: `event:${hook.id}`, kind: "opened" })).status).toBe(404);
    // An item that is not an event names its app, which must be readable.
    expect((await post(bobToken, { item: "ask:look:x", kind: "opened", app: "alice/secret" })).status).toBe(404);
    expect((await post(bobToken, { item: "ask:look:x", kind: "opened" })).status).toBe(404);
  });

  test("a browser session's cross-origin interaction is refused", async () => {
    const session = createSession(app.db, alice.id);
    const res = await fetch(`${servers.url}/api/v1/feed/interactions`, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        cookie: `forge_session=${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ item: "ask:look:x", kind: "muted", app: "alice/open" }),
    });
    expect(res.status).toBe(403);
  });

  test("mute silences an app; dismissal hides the one item", () => {
    const carol = bob;
    const before = readFeed(app.db, carol).items;
    const run = before.find((i) => i.kind === "run")!;
    recordInteraction(app.db, {
      viewerId: carol.id,
      itemId: run.id,
      kind: "dismissed",
      repoId: openRepo.id,
      actorId: alice.id,
    });
    const after = readFeed(app.db, carol).items;
    expect(after.some((i) => i.id === run.id)).toBe(false);
    expect(after.some((i) => i.kind === "map")).toBe(true);
    recordInteraction(app.db, {
      viewerId: carol.id,
      itemId: "event:whatever",
      kind: "muted",
      repoId: openRepo.id,
      actorId: null,
    });
    expect(readFeed(app.db, carol).items).toEqual([]);
    // Muting is the viewer's own: alice still hears from the app.
    expect(readFeed(app.db, alice).items.some((i) => i.app === "alice/open")).toBe(true);
  });
});

describe("affinity", () => {
  let dataDir: string;
  let app: App;
  let user: User;
  let repo: Repo;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-affinity-"));
    app = createApp({ dataDir, port: 0 });
    const u = await createUser(app.db, { trusted: true,
      username: "dana",
      email: "dana@forge.local",
      password: "a-good-passphrase",
    });
    if (!u.ok) throw new Error(u.error);
    user = u.value;
    const r = await createRepo(app, user, { name: "mine", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    repo = r.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const act = (kind: "opened" | "dismissed", ms: number) =>
    recordInteraction(app.db, {
      viewerId: user.id,
      itemId: "event:x",
      kind,
      repoId: repo.id,
      actorId: null,
      at: at(ms),
    });

  test("seeded from ownership, then moved by what was done, with decay", () => {
    const seed = affinityFor(app.db, user, NOW).app(repo.id);
    expect(seed.score).toBe(2);
    expect(seed.why).toBe("owns");
    act("opened", 0);
    const fresh = affinityFor(app.db, user, NOW).app(repo.id).score;
    expect(fresh).toBeCloseTo(3, 5);
    // Two weeks later the opening has lost three quarters of its weight.
    const later = affinityFor(app.db, user, NOW + 14 * DAY).app(repo.id).score;
    expect(later).toBeCloseTo(2.25, 5);
  });

  test("a dismissal outweighs the opening and leads the reason", () => {
    act("dismissed", 0);
    const w = affinityFor(app.db, user, NOW).app(repo.id);
    expect(w.score).toBeCloseTo(2 + 1 - 4, 5);
    expect(w.why).toBe("dismissed");
  });
});
