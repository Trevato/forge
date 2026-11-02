/**
 * `watchMilestone` (src/actions/watches.ts), called directly: a person who
 * can read the repository starts and stops watching and `isWatching`
 * follows; a guest is `unauthorized`, an agent `forbidden`, and someone who
 * cannot read the repository or names no milestone `not_found`. The watch is
 * the person's own state, so neither a start nor a stop appends an event —
 * checked on the bus and in the event table.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { watchMilestone } from "../src/actions/watches.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { isWatching } from "../src/core/watches.ts";

let dataDir: string;
let app: App;
let alice: User;
let bob: User;
let mason: User;
let engine: Repo;
let secret: Repo;
let release: Issue;
let plain: Issue;
let hidden: Issue;
const heard: ForgeEvent[] = [];
let unsubscribe: () => void;

const fresh = (repo: Repo) => getRepoById(app.db, repo.id)!;
const issue = (repo: Repo, title: string): Issue => {
  const opened = openIssue(app, alice, fresh(repo), { title });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
};
/** A milestone: an issue that waits for one part. */
const milestone = (repo: Repo, title: string): Issue => {
  const top = issue(repo, title);
  const part = issue(repo, `${title}'s part`);
  const linked = linkIssue(app, alice, fresh(repo), getIssueById(app.db, top.id)!, part);
  if (!linked.ok) throw new Error(String(linked.error));
  return top;
};
const events = (): number =>
  app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event").get()!.n;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-watch-action-"));
  app = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [
    ["alice", true],
    ["bob", false],
  ] as const) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  alice = getUserByName(app.db, "alice")!;
  bob = getUserByName(app.db, "bob")!;
  const repoOf = async (name: string, visibility: "public" | "private") => {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  // Public: bob reads the engine; the secret is alice's alone.
  engine = await repoOf("engine", "public");
  secret = await repoOf("secret", "private");
  const agent = await createAgent(app, alice, { username: "mason" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, engine, "mason").ok).toBe(true);
  mason = getUserByName(app.db, "mason")!;
  release = milestone(engine, "Release one");
  plain = issue(engine, "No milestone");
  hidden = milestone(secret, "A hidden milestone");
  unsubscribe = app.bus.subscribe((event) => heard.push(event));
}, 60_000);

afterAll(async () => {
  unsubscribe();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a person who can read the repository starts and stops watching, and isWatching follows", () => {
  const before = events();
  heard.length = 0;
  expect(isWatching(app.db, bob.id, release.id)).toBe(false);

  const on = watchMilestone(app, bob, fresh(engine), release.number, true);
  expect(on).toEqual({ ok: true, value: { watching: true } });
  expect(isWatching(app.db, bob.id, release.id)).toBe(true);
  // Twice is still once.
  expect(watchMilestone(app, bob, fresh(engine), release.number, true)).toEqual({
    ok: true,
    value: { watching: true },
  });
  // Bob's watch is his own: alice does not watch because he does.
  expect(isWatching(app.db, alice.id, release.id)).toBe(false);

  const off = watchMilestone(app, bob, fresh(engine), release.number, false);
  expect(off).toEqual({ ok: true, value: { watching: false } });
  expect(isWatching(app.db, bob.id, release.id)).toBe(false);

  // Neither a start nor a stop is an event.
  expect(heard).toEqual([]);
  expect(events()).toBe(before);
});

test("a guest is unauthorized, an agent forbidden", () => {
  const before = events();
  heard.length = 0;
  expect(watchMilestone(app, undefined, fresh(engine), release.number, true)).toEqual({
    ok: false,
    error: "unauthorized",
  });
  // Mason is on the engine's crew and reads it; an agent still does not watch.
  expect(watchMilestone(app, mason, fresh(engine), release.number, true)).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(isWatching(app.db, mason.id, release.id)).toBe(false);
  expect(heard).toEqual([]);
  expect(events()).toBe(before);
});

test("a repository that cannot be read and a number that is no milestone are not_found", () => {
  const before = events();
  heard.length = 0;
  // Bob cannot read the secret: the same answer as no milestone at all.
  expect(watchMilestone(app, bob, fresh(secret), hidden.number, true)).toEqual({
    ok: false,
    error: "not_found",
  });
  expect(isWatching(app.db, bob.id, hidden.id)).toBe(false);
  // The owner may.
  expect(watchMilestone(app, alice, fresh(secret), hidden.number, true).ok).toBe(true);
  expect(watchMilestone(app, alice, fresh(secret), hidden.number, false).ok).toBe(true);
  // An issue that waits for nothing, a number nobody holds, and no integer.
  for (const number of [plain.number, 9999, 1.5, Number.NaN]) {
    expect(watchMilestone(app, bob, fresh(engine), number, true), String(number)).toEqual({
      ok: false,
      error: "not_found",
    });
  }
  expect(isWatching(app.db, bob.id, plain.id)).toBe(false);
  expect(heard).toEqual([]);
  expect(events()).toBe(before);
});
