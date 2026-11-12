/** repoAdminNames: who a writer is told can act on a repository (#10196). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { repoAdminNames } from "../src/core/repo_admins.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
const ids: Record<string, string> = {};
const repoOf = (ownerId: string): Repo => ({ ownerId }) as Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-repo-admins-"));
  app = createApp({ dataDir, port: 0 });
  for (const [i, username] of ["alice", "pat", "gone", "kay", "lone"].entries()) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: i === 0,
    });
    if (!made.ok) throw new Error(String(made.error));
    ids[username] = made.value.id;
  }
  const org = createOrg(app.db, "acme", ids["pat"]!);
  if (!org.ok) throw new Error(org.error);
  ids["acme"] = org.value.id;
  const admins = createTeam(app.db, org.value.id, "ops", "admin");
  if (!admins.ok) throw new Error(admins.error);
  addTeamMember(app.db, admins.value, ids["gone"]!);
  addTeamMember(app.db, admins.value, ids["kay"]!);
  app.db.run("UPDATE user SET suspended_at = ?2 WHERE id = ?1", [ids["gone"]!, new Date().toISOString()]);
  const bare = createOrg(app.db, "bare", ids["lone"]!);
  if (!bare.ok) throw new Error(bare.error);
  ids["bare"] = bare.value.id;
  app.db.run("DELETE FROM team_member WHERE user_id = ?1", [ids["lone"]!]);
  const writers = createTeam(app.db, bare.value.id, "devs", "write");
  if (!writers.ok) throw new Error(writers.error);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a personal repository is administered by its owner", () => {
  expect(repoAdminNames(app.db, repoOf(ids["pat"]!))).toEqual(["pat"]);
});

test("an org's admin-team members are named, a suspended one left out", () => {
  expect(repoAdminNames(app.db, repoOf(ids["acme"]!))).toEqual(["kay", "pat"]);
});

test("an org with no admin-team members names nobody", () => {
  expect(repoAdminNames(app.db, repoOf(ids["bare"]!))).toEqual([]);
});

test("a repository whose owner is gone names nobody", () => {
  expect(repoAdminNames(app.db, repoOf("nope"))).toEqual([]);
});
