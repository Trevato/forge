/** The minute's clog tick (#6524): start notifies once, clear posts once, a restart repeats neither. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { setNotifyUrl, startNotifier, type Notifier } from "../src/crew/notify.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { lastClearedNote, loadClog, tickClog } from "../src/flow/clog_tick.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const MIN = 60_000;
let dataDir = "";
let app: App;
let alice: User;
let was: string | undefined;
const posts: string[] = [];
const notifiers: Notifier[] = [];

const boot = async (): Promise<Notifier> => {
  const n = startNotifier(app, {
    forgeUrl: "https://forge.example.test",
    drainingSince: () => null,
    send: async (_u, body) => {
      posts.push(body);
      return true;
    },
  });
  notifiers.push(n);
  await n.settled();
  return n;
};

beforeAll(async () => {
  was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "alice/forge";
  dataDir = await mkdtemp(join(tmpdir(), "forge-clog-tick-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-long-clog-tick-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  setNotifyUrl(app.db, alice.id, "https://ntfy.example.test/root-topic");
  await createAgent(app, alice, { username: "bot" });
  const made = await createRepo(app, alice, { name: "forge", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# f\n" }] });
  addToCrew(app, alice, repo, "bot");
  // Ten pulls opened and none landed over 2 h: a clog by the landing ratio.
  for (let i = 0; i < 10; i++) {
    await commitToBranch(app, alice, repo, {
      branch: `bot/${i}`,
      base: "main",
      message: `p${i}`,
      files: [{ path: `F${i}.md`, content: `${i}\n` }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: `p${i}`,
      body: "",
      baseBranch: "main",
      headBranch: `bot/${i}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
  }
}, 60_000);

afterAll(async () => {
  for (const n of notifiers) await n.close();
  if (was === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = was;
  await rm(dataDir, { recursive: true, force: true });
});

test("across ticks, start notifies once and clear posts once, through a restart", async () => {
  const t0 = new Date();
  const first = await boot();
  expect(tickClog(app.db, app.bus, t0).event).toBe("started");
  await first.settled();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("Clogged:");

  // Still clogged: no second event, no second notification.
  expect(tickClog(app.db, app.bus, new Date(t0.getTime() + MIN)).event).toBeNull();
  await first.settled();
  expect(posts).toHaveLength(1);

  // A restart: the watch state is the database's, and the new notifier says nothing.
  await first.close();
  expect(loadClog(app.db)?.since).toBe(t0.getTime());
  const second = await boot();
  expect(tickClog(app.db, app.bus, new Date(t0.getTime() + 2 * MIN)).event).toBeNull();
  await second.settled();
  expect(posts).toHaveLength(1);

  // The pile leaves the 2 h window: two quiet ticks clear it, once.
  const later = t0.getTime() + 3 * 60 * MIN;
  expect(tickClog(app.db, app.bus, new Date(later)).event).toBeNull();
  expect(tickClog(app.db, app.bus, new Date(later + MIN)).event).toBe("cleared");
  expect(tickClog(app.db, app.bus, new Date(later + 2 * MIN)).event).toBeNull();
  expect(app.db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'clog.cleared'").get()).toEqual({ n: 1 });
  expect(loadClog(app.db)).toBeNull();
  await second.settled();
  expect(posts).toHaveLength(1);

  // The note is on the admin's feed, once.
  const mine = candidatesFor(app.db, alice, later).filter((c) => c.what.startsWith("Clog cleared"));
  expect(mine).toHaveLength(1);
  expect(mine[0]!.what).toContain("Clog cleared. Cause:");
  expect(mine[0]!.what).not.toContain("Time to detect");
  // The terminal's home reads the same note from the same event.
  expect(lastClearedNote(app.db, new Date(later))).toContain("Clog cleared. Cause:");
  expect(lastClearedNote(app.db, new Date(later + 25 * 60 * MIN))).toBeUndefined();
  // Both doors drop the note after the same window.
  const dayOn = Date.now() + 25 * 60 * MIN;
  expect(candidatesFor(app.db, alice, dayOn).filter((c) => c.what.startsWith("Clog cleared"))).toHaveLength(0);
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-long-clog-tick-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  expect(candidatesFor(app.db, bob.value, later).filter((c) => c.what.startsWith("Clog cleared"))).toHaveLength(0);
}, 30_000);

test("the note reports the peak stranded dollars, not the figure at the clear", () => {
  const far = Date.now() + 20 * 60 * MIN;
  // A clog that stood with 50 dollars stranded; by now nothing is stranded.
  app.db.query("INSERT INTO clog_state (id, since, first_reasons, quiet, peak_usd) VALUES (1, ?1, ?2, 0, 50)").run(far - 30 * MIN, "[\"x\"]");
  expect(tickClog(app.db, app.bus, new Date(far)).event).toBeNull();
  expect(loadClog(app.db)?.peakUsd).toBe(50);
  expect(tickClog(app.db, app.bus, new Date(far + MIN)).event).toBe("cleared");
  expect(lastClearedNote(app.db, new Date(far + MIN))).toContain("Stranded at peak: $50");
});

test("a clear with no own repository still clears the watch and posts no note", () => {
  const was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "alice/nowhere";
  try {
    const far = Date.now() + 10 * 60 * 60 * MIN;
    app.db.query("INSERT INTO clog_state (id, since, first_reasons, quiet) VALUES (1, ?1, ?2, 1)").run(far - MIN, "[\"x\"]");
    expect(tickClog(app.db, app.bus, new Date(far)).event).toBe("cleared");
    expect(loadClog(app.db)).toBeNull();
    expect(app.db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'clog.cleared'").get()).toEqual({ n: 2 });
  } finally {
    process.env.FORGE_SENTINEL_REPO = was;
  }
});
