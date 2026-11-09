/** A pull turning failed speaks once in its writers' feed, and only to them (#10135). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { recordPull } from "../src/apps/pull.ts";
import { classifiedAudience } from "../src/core/event_audience.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("sync failed feed line", () => {
  let dataDir: string;
  let app: App;
  let appId: string;

  const ok = () => recordPull(app.db, appId, { ok: true, pulled: 1, skipped: 0, errors: 0, cursor: `c${Math.random()}`, durationMs: 1 }, app.bus);
  const fail = (reason: string) => recordPull(app.db, appId, { ok: false, reason, durationMs: 1 }, app.bus);
  const lines = (name: string) => {
    const viewer = getUserByName(app.db, name)!;
    return candidatesFor(app.db, viewer, Date.now(), undefined, false).filter((c) => c.said?.includes("sync failed"));
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sync-failed-"));
    app = createApp({ dataDir, port: 0 });
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob",
      email: "bob@forge.local", password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    const made = await newApp(app, getUserByName(app.db, "alice")!, { name: "hello", visibility: "public" } as never);
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "hello")!;
    appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
  });
  afterAll(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("ok, failed, failed, ok leaves exactly one line, for a writer and not a reader", () => {
    ok();
    fail("<b>status 500</b> " + "x".repeat(200));
    fail("status 502 is not 2xx");
    ok();
    const mine = lines("alice");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.said!.startsWith("alice/hello sync failed: <b>status 500</b> ")).toBe(true);
    expect(mine[0]!.said!.length).toBeLessThanOrEqual("alice/hello sync failed: ".length + 120);
    expect(mine[0]!.link).toBe("/alice/hello/app");
    expect(lines("bob")).toHaveLength(0);
  });

  test("a failure after a recovery speaks again; the first ever pull failing speaks", () => {
    fail("status 503 is not 2xx");
    expect(lines("alice")).toHaveLength(2);
    expect(classifiedAudience("adapter.sync_failed")).toBe("writers");
  });

  // The terminal feed (`tui/screens/feed.ts`) calls `readFeed`, which reads `candidatesFor`.
  test("the terminal's feed read shows the line to a writer and not to a reader", () => {
    const seen = (name: string) =>
      readFeed(app.db, getUserByName(app.db, name)!, { limit: 50 }).items.filter((i) => i.what.includes("sync failed"));
    expect(seen("alice").length).toBeGreaterThan(0);
    expect(seen("bob")).toHaveLength(0);
  });

  test("the event is appended only once the run is committed", () => {
    let inTransaction: boolean | undefined;
    const bus = { append: (input: Parameters<App["bus"]["append"]>[0]) => ((inTransaction = app.db.inTransaction), app.bus.append(input)) };
    ok();
    recordPull(app.db, appId, { ok: false, reason: "late", durationMs: 1 }, bus);
    expect(inTransaction).toBe(false);
  });
});
