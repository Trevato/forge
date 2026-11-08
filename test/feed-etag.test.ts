/** GET /api/v1/feed answers 304 only when nothing the viewer would read has changed. */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { recordInteraction, removeDismissals } from "../src/core/interactions.ts";
import { chipsOf, setChip } from "../src/core/feed_chips.ts";
import { addShare } from "../src/core/shares.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { feedTag, TAG_BUCKET_MS } from "../src/feed/feed_tag.ts";
import { WAIT_LIMIT_MS } from "../src/core/pull_wait.ts";
import { promote } from "./helpers/members.ts";

const T0 = Date.parse("2026-10-26T12:00:30Z");

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let dana: User;
let openRepo: Repo;
let secretRepo: Repo;
let tokens: Record<string, string>;

const emit = (repo: Repo, kind: string, actor: User, payload = {}) =>
  app.bus.append({ kind, repoId: repo.id, actorId: actor.id, payload });

const get = (who: string, path = "/api/v1/feed", etag?: string) =>
  fetch(`${servers.url}${path}`, {
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(etag === undefined ? {} : { "if-none-match": etag }),
    },
  });

/** The tag a first read gives, after draining its body. */
const tagOf = async (who: string, path?: string): Promise<string> => {
  const res = await get(who, path);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  return res.headers.get("etag")!;
};

beforeAll(async () => {
  setSystemTime(new Date(T0));
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-etag-"));
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
  dana = await mk("dana");
  tokens = {
    alice: createToken(app.db, alice.id, "t", "rw").token,
    bob: createToken(app.db, bob.id, "t", "rw").token,
    dana: createToken(app.db, dana.id, "t", "rw").token,
  };
  const s = await createRepo(app, alice, { name: "secret", visibility: "private" });
  const o = await createRepo(app, alice, { name: "open", visibility: "public" });
  if (!s.ok || !o.ok) throw new Error("repos");
  secretRepo = s.value;
  openRepo = o.value;
  emit(openRepo, "run.finished", alice, { kind: "deploy", state: "ok", summary: "up", runId: "r1" });
});

afterAll(async () => {
  setSystemTime();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the feed's ETag", () => {
  test("200, then 304 with no body, the security headers and no render phase", async () => {
    const first = await get("bob");
    await first.arrayBuffer();
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"[0-9a-z]+"$/);
    expect(first.headers.get("server-timing")).toContain("render");
    const again = await get("bob", "/api/v1/feed", tag);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("referrer-policy")).not.toBeNull();
    expect(again.headers.get("content-security-policy")).not.toBeNull();
    expect(again.headers.get("server-timing") ?? "").not.toContain("render");
    expect((await get("bob", "/api/v1/feed", 'W/"other"')).status).toBe(200);
  });

  test("a new event, a share, a dismissal and a mute each make the next read a 200", async () => {
    let tag = await tagOf("bob");
    emit(openRepo, "run.finished", alice, { kind: "deploy", state: "ok", summary: "again", runId: "r2" });
    expect((await get("bob", "/api/v1/feed", tag)).status).toBe(200);

    tag = await tagOf("bob");
    expect((await get("bob", "/api/v1/feed", tag)).status).toBe(304);
    addShare(app.db, {
      itemId: "event:shared-1",
      senderId: alice.id,
      recipientId: bob.id,
      repoId: openRepo.id,
      kind: "run",
      link: "/alice/open",
      what: "a run",
      state: "delivered",
      at: Date.now(),
    });
    expect((await get("bob", "/api/v1/feed", tag)).status).toBe(200);

    tag = await tagOf("bob");
    recordInteraction(app.db, {
      viewerId: bob.id,
      itemId: "event:nothing",
      kind: "dismissed",
      repoId: openRepo.id,
      actorId: null,
    });
    expect((await get("bob", "/api/v1/feed", tag)).status).toBe(200);

    tag = await tagOf("bob");
    expect((await get("bob", "/api/v1/feed", tag)).status).toBe(304);
    recordInteraction(app.db, {
      viewerId: bob.id,
      itemId: "repo:x",
      kind: "muted",
      repoId: openRepo.id,
      actorId: null,
    });
    expect((await get("bob", "/api/v1/feed", tag)).status).toBe(200);
  });

  test("undoing a dismissal, which deletes a row, makes the next read a 200", async () => {
    for (const item of ["event:old", "event:newer"])
      recordInteraction(app.db, {
        viewerId: dana.id,
        itemId: item,
        kind: "dismissed",
        repoId: openRepo.id,
        actorId: null,
      });
    const mine = await tagOf("bob");
    expect((await get("bob", "/api/v1/feed", mine)).status).toBe(304);
    removeDismissals(app.db, bob.id, ["event:nothing"]);
    expect((await get("bob", "/api/v1/feed", mine)).status).toBe(200);
    const held = await tagOf("dana");
    removeDismissals(app.db, dana.id, ["event:old"]);
    expect((await get("dana", "/api/v1/feed", held)).status).toBe(200);
  });

  test("a switched-off chip changes the tag, and so does the next minute and the 24 h wait line", async () => {
    const tag = await tagOf("alice");
    expect((await get("alice", "/api/v1/feed", tag)).status).toBe(304);
    setChip(app.db, alice.id, { kind: "kind", value: "reviews" }, true);
    expect((await get("alice", "/api/v1/feed", tag)).status).toBe(200);
    setChip(app.db, alice.id, { kind: "kind", value: "reviews" }, false);

    const held = await tagOf("alice");
    try {
      setSystemTime(new Date(T0 + TAG_BUCKET_MS));
      expect((await get("alice", "/api/v1/feed", held)).status).toBe(200);
      const next = await tagOf("alice");
      expect((await get("alice", "/api/v1/feed", next)).status).toBe(304);
      setSystemTime(new Date(T0 + WAIT_LIMIT_MS + 1));
      expect((await get("alice", "/api/v1/feed", next)).status).toBe(200);
    } finally {
      setSystemTime(new Date(T0));
    }
  });

  test("a different limit or cursor gives a different tag, over the same data", async () => {
    const plain = await tagOf("alice");
    const limited = await tagOf("alice", "/api/v1/feed?limit=1");
    const cursored = await tagOf("alice", "/api/v1/feed?cursor=1.5%7Cevent:abc");
    expect(new Set([plain, limited, cursored]).size).toBe(3);
    expect((await get("alice", "/api/v1/feed?limit=1", plain)).status).toBe(200);
  });

  test("two viewers differ, and a private repository's news reaches only the one who can read it", async () => {
    expect(await tagOf("alice")).not.toBe(await tagOf("bob"));
    const bobTag = await tagOf("bob");
    const aliceTag = await tagOf("alice");
    emit(secretRepo, "run.finished", alice, { kind: "deploy", state: "failed", summary: "boom", runId: "r3" });
    // The write clock is forge-wide, so both re-read; only alice's page changes.
    const forBob = await get("bob", "/api/v1/feed", bobTag);
    const forAlice = await get("alice", "/api/v1/feed", aliceTag);
    expect(forBob.status).toBe(200);
    expect(forAlice.status).toBe(200);
    expect(JSON.stringify(await forBob.json())).not.toContain("alice/secret");
    expect(JSON.stringify(await forAlice.json())).toContain("alice/secret");
  });

  test("a viewer with shares still queued never gets a 304", async () => {
    for (let n = 0; n < 5; n++)
      addShare(app.db, {
        itemId: `event:today-${n}`,
        senderId: alice.id,
        recipientId: dana.id,
        repoId: openRepo.id,
        kind: "run",
        link: "/alice/open",
        what: "a run",
        state: "delivered",
        at: Date.now(),
      });
    addShare(app.db, {
      itemId: "event:waiting",
      senderId: alice.id,
      recipientId: dana.id,
      repoId: openRepo.id,
      kind: "run",
      link: "/alice/open",
      what: "a run",
      state: "queued",
      at: Date.now(),
    });
    const tag = await tagOf("dana");
    expect((await get("dana", "/api/v1/feed", tag)).status).toBe(200);
    expect((await get("dana", "/api/v1/feed", tag)).status).toBe(200);
  });

  test("feedTag takes `now`, and a tag in the same minute is the same", () => {
    const input = { chips: chipsOf(app.db, bob.id), cursor: null, limit: null };
    const at = (now: number) => feedTag(app.db, bob, { ...input, now });
    expect(at(T0)).toBe(at(T0 + 1000));
    expect(at(T0)).not.toBe(at(T0 + 2 * TAG_BUCKET_MS));
  });
});
