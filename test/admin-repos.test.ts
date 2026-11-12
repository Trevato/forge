/** One statement answers the repositories a person administers (#7056). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { adminRepoIds } from "../src/core/admin_repos.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { canAdmin, getRepoById } from "../src/core/repos.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { statements } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let root: User;
let pat: User;
let bot: User;
const mine: Record<string, string> = {};

const person = async (username: string): Promise<User> => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};
const repo = (ownerId: string, name: string): string => {
  const rid = id();
  app.db
    .query(
      `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
       VALUES (?1, ?2, ?3, 'private', '', 'main')`,
    )
    .run(rid, ownerId, name);
  return rid;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-admin-repos-"));
  app = createApp({ dataDir, port: 0 });
  root = await person("alice");
  pat = await person("pat");
  const other = await person("other");
  const org = (n: string, founder: User): User => {
    const r = createOrg(app.db, n, founder.id);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const owned = org("owned", pat); // pat is in Owners
  const adminOrg = org("adminorg", other);
  const writeOrg = org("writeorg", other);
  const readOrg = org("readorg", other);
  const joined = (o: User, name: string, perm: "admin" | "write" | "read") => {
    const t = createTeam(app.db, o.id, name, perm);
    if (!t.ok) throw new Error(t.error);
    addTeamMember(app.db, t.value, pat.id);
  };
  joined(adminOrg, "leads", "admin");
  joined(writeOrg, "devs", "write");
  joined(readOrg, "viewers", "read");
  mine["own"] = repo(pat.id, "own");
  mine["org-owner"] = repo(owned.id, "a");
  mine["team-admin"] = repo(adminOrg.id, "b");
  mine["writer"] = repo(writeOrg.id, "c");
  mine["reader"] = repo(readOrg.id, "d");
  mine["foreign"] = repo(other.id, "e");
  const botId = id();
  app.db
    .query(
      `INSERT INTO user (id, username, email, password_hash, is_agent)
       VALUES (?1, 'bot', 'bot@forge.local', '!', 1)`,
    )
    .run(botId);
  bot = getUserById(app.db, botId)!;
  app.db
    .query("INSERT INTO repo_crew (repo_id, user_id) VALUES (?1, ?2)")
    .run(mine["writer"]!, botId);
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const every = (): string[] =>
  app.db.query<{ id: string }, []>("SELECT id FROM repo").all().map((r) => r.id);

test("each route to admin is in, writer-only and reader-only are out, and it equals canAdmin", () => {
  const got = adminRepoIds(app.db, pat);
  expect([...got].sort()).toEqual(
    [mine["own"]!, mine["org-owner"]!, mine["team-admin"]!].sort(),
  );
  for (const rid of every())
    expect(got.has(rid)).toBe(canAdmin(app.db, getRepoById(app.db, rid)!, pat));
});

test("a forge admin gets every repository, an agent and nobody get none", () => {
  expect(adminRepoIds(app.db, root).size).toBe(every().length);
  expect(adminRepoIds(app.db, bot).size).toBe(0);
  expect(adminRepoIds(app.db, undefined).size).toBe(0);
});

test("it is exactly one statement", () => {
  let n = 0;
  const db = app.db as unknown as { query: (...a: unknown[]) => unknown };
  const real = db.query.bind(db);
  db.query = (...a: unknown[]) => {
    n++;
    return real(...a);
  };
  try {
    adminRepoIds(app.db, pat);
  } finally {
    db.query = real;
  }
  expect(n).toBe(1);
});

test("on 2,000 repositories it is still one statement", async () => {
  app.db.transaction(() => {
    for (let i = 0; i < 2000; i++) repo(i % 3 === 0 ? pat.id : root.id, `bulk${i}`);
  })();
  // Counted, not timed: one statement however many repositories there are.
  expectWork(await statements(app.db, () => void adminRepoIds(app.db, pat)), { max: 1 });
  expect(adminRepoIds(app.db, pat).size).toBe(667 + 3);
});
