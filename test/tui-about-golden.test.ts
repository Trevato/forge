/**
 * The About card's golden path row (#7488): an app's first preview and first
 * production deploy, in `goldenPathLine`'s words; nothing on a fresh app or a
 * repository that is not an app.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { aboutScreen, paceRows } from "../src/tui/screens/about.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { localSource } from "../src/view/local.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

let dataDir = "";
let app: App;
let alice: User;
let n = 0;

const repoNamed = async (): Promise<Repo> => {
  n += 1;
  const made = await createRepo(app, alice, { name: `golden${n}`, visibility: "private" });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};
const asApp = (repo: Repo): void => {
  const made = insertApp(app.db, { repoId: repo.id, slug: repo.name, access: "private" });
  if (!made.ok) throw new Error(made.error);
  app.db.query("UPDATE app SET created_at = ?1 WHERE id = ?2").run(at(0), made.value.id);
};
const deploy = (repo: Repo, env: string, created: number, serving: number): void => {
  app.db
    .query(
      `INSERT INTO run (id, repo_id, kind, env, state, created_at, serving_at)
       VALUES (?1, ?2, 'deploy', ?3, 'ok', ?4, ?5)`,
    )
    .run(`r${Math.random()}`, repo.id, env, at(created), at(serving));
};
const merge = (repo: Repo, mergedAt: number): void => {
  app.db
    .query(`INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, 1, 'pull', 'p', ?3)`)
    .run(`i${repo.id}`, repo.id, alice.id);
  app.db
    .query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
       VALUES (?1, ?2, 'h', 'a', 'b', ?3)`,
    )
    .run(`i${repo.id}`, repo.defaultBranch, at(mergedAt));
};
const session = (user: User | undefined): Session =>
  ({ app, db: app.db, user }) as unknown as Session;
const rowsOf = (repo: Repo, user: User = alice): [string, string][] =>
  paceRows(session(user), getRepoById(app.db, repo.id));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-about-golden-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.test",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
});

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an app with a first preview and a first production deploy draws both on one line", async () => {
  const repo = await repoNamed();
  asApp(repo);
  deploy(repo, "pull-1", 60_000, 180_000);
  merge(repo, 30 * 60_000);
  deploy(repo, "production", 31 * 60_000, 60 * 60_000);
  expect(rowsOf(repo)).toEqual([
    ["golden path", "first preview 3m after New app · in production 1h"],
  ]);
});

test("a figure that does not exist yet is left out", async () => {
  const repo = await repoNamed();
  asApp(repo);
  deploy(repo, "pull-1", 1000, 14_000);
  expect(rowsOf(repo)).toEqual([["golden path", "first preview 14s after New app"]]);
});

test("a fresh app, a repository that is not an app, and a stranger draw nothing", async () => {
  const fresh = await repoNamed();
  asApp(fresh);
  expect(rowsOf(fresh)).toEqual([]);
  const plain = await repoNamed();
  deploy(plain, "pull-1", 1000, 2000);
  expect(rowsOf(plain)).toEqual([]);
  const hidden = await repoNamed();
  asApp(hidden);
  deploy(hidden, "pull-1", 1000, 2000);
  const bob = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.test",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(bob.error);
  expect(rowsOf(hidden, bob.value)).toEqual([]);
});

test("the About card draws the row on an app and not on a plain repository", async () => {
  const ctx = {
    theme: theme("dark"),
    invalidate() {}, toast() {}, push() {}, pop() {}, copy() {},
  } as unknown as Ctx;
  const draw = (repo: Repo): string => {
    const f = session(alice);
    const src = localSource(app, getRepoById(app.db, repo.id)!, alice);
    const screen = aboutScreen(f, ctx, { render() {} } as unknown as Screen, src, undefined, "main");
    const s = new Surface(110, 40);
    screen.render({ x: 0, y: 0, w: 110, h: 40 }, s);
    return s.toText();
  };
  const shown = await repoNamed();
  asApp(shown);
  deploy(shown, "pull-1", 1000, 120_000);
  expect(draw(shown)).toContain("first preview 2m after New app");
  const plain = await repoNamed();
  expect(draw(plain)).not.toContain("golden path");
});
