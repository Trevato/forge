/** The explorer ranks by likes (#7753): the order, what a viewer may count, and the line's round trip. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { explore, exploreLine, parseExploreQuery } from "../src/actions/explore.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let bob: User;
const ids = new Map<string, string>();

async function mk(username: string, first = false): Promise<User> {
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
}

async function made(name: string, visibility: "public" | "private"): Promise<void> {
  const repo = await createRepo(app, alice, { name, visibility });
  if (!repo.ok) throw new Error(String(repo.error));
  const rec = insertApp(app.db, { repoId: repo.value.id, slug: `alice-${name}`, access: visibility });
  if (!rec.ok) throw new Error(rec.error);
  ids.set(name, repo.value.id);
}

function like(name: string, n: number, who: User[]): void {
  for (let i = 0; i < n; i++)
    app.db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [
      who[i % who.length]!.id,
      `${name}-${i}`,
      ids.get(name)!,
    ]);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-explore-likes-"));
  app = createApp({ dataDir, port: 0 });
  await mk("founder", true);
  alice = await mk("alice");
  bob = await mk("bob");
  await made("quiet", "public");
  await made("loved", "public");
  await made("hidden", "private");
  like("loved", 3, [alice]);
  like("quiet", 1, [alice]);
  like("hidden", 5, [alice]);
});
afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const apps = parseExploreQuery("kind:app sort:likes");

test("sort:likes orders apps by their likes and shows the count", async () => {
  const rows = await explore(app, bob, apps);
  expect(rows.map((r) => r.name)).toEqual(["alice/loved", "alice/quiet"]);
  expect(rows.map((r) => r.numbers.likes)).toEqual([3, 1]);
});

test("a private app's likes are counted only for those who can read it", async () => {
  const seen = await explore(app, bob, parseExploreQuery("sort:likes"));
  expect(seen.some((r) => r.name === "alice/hidden")).toBe(false);
  expect(seen.find((r) => r.name === "alice")!.numbers.likes).toBe(4);
  const own = await explore(app, alice, apps);
  expect(own.map((r) => r.name)).toEqual(["alice/hidden", "alice/loved", "alice/quiet"]);
  expect((await explore(app, undefined, apps)).map((r) => r.numbers.likes)).toEqual([3, 1]);
});

test("likes lift the score sort modestly", async () => {
  const rows = await explore(app, bob, parseExploreQuery("kind:app"));
  expect(rows[0]!.name).toBe("alice/loved");
  expect(rows[0]!.score).toBeGreaterThan(rows[1]!.score);
  expect(rows[0]!.score).toBeLessThan(1.5);
});

test("sort:likes round-trips through the line", () => {
  const q = parseExploreQuery("kind:app sort:likes garden");
  expect(q.sort).toBe("likes");
  expect(exploreLine(q)).toBe("kind:app sort:likes garden");
});
