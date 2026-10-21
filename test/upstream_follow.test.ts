/**
 * A repository's upstream setting (#3442, layer 1): stored as a row, https
 * or http only, and an admin's to read.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  getFollow,
  listFollowing,
  noteCheck,
  putFollow,
  upstreamUrl,
} from "../src/core/upstream_follow.ts";

let dataDir = "";
let app: App;
let alice: User;
let guest: User;
let repo: Repo;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-upstream-follow-"));
  app = createApp({ dataDir, port: 0 });
  const user = (username: string, extra: object = {}) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...extra,
    });
  alice = ok(await user("alice", { adminIfFirst: true }));
  guest = ok(await user("guest"));
  repo = ok(await createRepo(app, alice, { name: "square", visibility: "public" }));
});

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("upstreamUrl", () => {
  test("https and http are accepted", () => {
    expect(upstreamUrl("https://example.com/a/b.git")).toBe("https://example.com/a/b.git");
    expect(upstreamUrl("http://example.com/a/b")).toBe("http://example.com/a/b");
  });

  for (const bad of [
    "git://example.com/a/b.git",
    "ssh://git@example.com/a/b.git",
    "file:///etc/passwd",
    "https://user:pw@example.com/a/b",
    "https://user@example.com/a/b",
    "ext::sh -c id",
    "example.com/a/b",
    "",
  ])
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(upstreamUrl(bad)).toBeUndefined();
    });

  test("putFollow will not store one either", () => {
    expect(() =>
      putFollow(app.db, {
        repoId: repo.id,
        url: "git://example.com/a/b.git",
        branch: "main",
        enabled: true,
        byId: alice.id,
        originId: "",
      }),
    ).toThrow();
    expect(getFollow(app.db, repo.id)).toBeUndefined();
  });
});

describe("the follow row", () => {
  test("written, read, listed when on, and a new address forgets the last reading", () => {
    const put = (url: string, enabled: boolean) =>
      putFollow(app.db, { repoId: repo.id, url, branch: "main", enabled, byId: alice.id, originId: "" });
    const first = put("https://example.com/a/b.git", false);
    expect([first.url, first.enabled, first.checking, first.checkedAt]).toEqual([
      "https://example.com/a/b.git",
      false,
      null,
      null,
    ]);
    expect(listFollowing(app.db)).toEqual([]);
    put("https://example.com/a/b.git", true);
    noteCheck(app.db, repo.id, { at: "2026-10-21T00:00:00.000Z", tip: "abc", behind: 3, error: "" });
    expect(getFollow(app.db, repo.id)).toMatchObject({ enabled: true, tip: "abc", behind: 3 });
    expect(listFollowing(app.db).map((f) => f.repoId)).toEqual([repo.id]);
    expect(put("https://example.com/c/d.git", true)).toMatchObject({
      checkedAt: null,
      tip: "",
      behind: 0,
    });
  });
});

describe("who hears of it", () => {
  test("a guest's events do not carry the URL; an admin's do", () => {
    const secret = "https://private.example.com/secret/repo.git";
    app.bus.append({
      kind: "repo.upstream_follow",
      repoId: repo.id,
      actorId: alice.id,
      payload: { url: secret, enabled: true },
    });
    const seen = (viewer: User) =>
      JSON.stringify(listEvents(app.db, { repoId: repo.id }).filter(audienceFilter(app.db, viewer)));
    expect(seen(alice)).toContain(secret);
    expect(seen(guest)).not.toContain(secret);
  });
});
