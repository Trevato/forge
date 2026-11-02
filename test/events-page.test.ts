/**
 * A repository's events page. The audience filter runs before the page is
 * cut, so hidden events never shift a page; one request reads at most 1,000
 * rows, so a mostly hidden outbox comes back short with a cursor that resumes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { eventsLimit, eventsPage, validEventsCursor } from "../src/core/events_page.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("events limit and cursor", () => {
  test("limit defaults to 50 and accepts 1 to 200", () => {
    expect(eventsLimit(undefined)).toBe(50);
    expect(eventsLimit(null)).toBe(50);
    expect(eventsLimit("1")).toBe(1);
    expect(eventsLimit(200)).toBe(200);
    for (const bad of [0, 201, "1.5", "-3", "12345", "abc"]) {
      expect(eventsLimit(bad)).toBeUndefined();
    }
  });

  test("a cursor is 1 to 64 id characters", () => {
    expect(validEventsCursor("abc_DEF-123")).toBe(true);
    expect(validEventsCursor("a".repeat(64))).toBe(true);
    expect(validEventsCursor("")).toBe(false);
    expect(validEventsCursor("a".repeat(65))).toBe(false);
    expect(validEventsCursor("/")).toBe(false);
  });
});

describe("a repository's events page", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;

  const emit = (kind: string, n: number) =>
    app.bus.append({ kind, repoId: repo.id, actorId: alice.id, payload: { n } });

  const user = async (username: string, first = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  const fresh = async (name: string) => {
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-events-page-"));
    app = createApp({ dataDir, port: 0 });
    alice = await user("alice", true);
    bob = await user("bob");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("hidden events never shift a page, and paging lists each visible event once", async () => {
    await fresh("mixed");
    const visible: number[] = [];
    for (let i = 0; i < 12; i++) {
      emit("push", i);
      visible.push(i);
      emit("webhook.created", i);
      emit("webhook.created", i + 100);
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const page = eventsPage(app.db, repo.id, bob, 5, cursor);
      sizes.push(page.items.length);
      for (const e of page.items) {
        expect(e.kind).not.toBe("webhook.created");
        if (e.kind === "push") seen.push((e.payload as { n: number }).n);
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(sizes.slice(0, 2)).toEqual([5, 5]);
    expect(seen).toEqual(visible.slice().reverse());
    // The admin sees everything, hidden or not.
    expect(eventsPage(app.db, repo.id, alice, 200).items.length).toBeGreaterThan(36);
  });

  test("1,200 hidden events in front of 1 visible: a short page, a cursor, then the event", async () => {
    await fresh("buried");
    const first = emit("push", 0);
    for (let i = 0; i < 1200; i++) emit("webhook.created", i);
    const one = eventsPage(app.db, repo.id, bob, 10);
    expect(one.items.length).toBeLessThan(10);
    expect(one.items).toEqual([]);
    expect(one.next_cursor).not.toBeNull();
    const two = eventsPage(app.db, repo.id, bob, 10, one.next_cursor!);
    expect(two.items.map((e) => e.id)).toContain(first.id);
    expect(two.items.every((e) => e.kind !== "webhook.created")).toBe(true);
    expect(two.next_cursor).toBeNull();
  });
});
