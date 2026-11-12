/**
 * Seating the first ask's app (#11508): the forge's own agents are kept, a
 * missing role is made, and a seat that cannot be filled says so (false).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow, listAgents, listCrewRoles } from "../src/core/agents.ts";
import { createRepo as createRepoRow, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { seatFirstAskCrew } from "../src/spawn/starter_crew.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let owner = "";
let repo: Repo;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-first-ask-seat-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "maria", email: "m@x.test", password: "a-long-seating-passphrase", isAdmin: true });
  if (!u.ok) throw new Error("user");
  owner = u.value.id;
  const r = await createRepoRow(app.db, join(dir, "repos"), { ownerId: owner, name: "menu" });
  if (!r.ok) throw new Error("repo");
  repo = r.value;
});
afterEach(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function agent(name: string, roles: ("builder" | "reviewer")[]): Promise<string> {
  const u = await createUser(app.db, { username: name, email: `${name}@agents.spawn.forge.invalid`, agent: true, origin: "spawn" });
  if (!u.ok) throw new Error("agent");
  createAgentRow(app.db, { userId: u.value.id, roles });
  return u.value.id;
}

const seats = () => listCrewRoles(app.db, repo.id).map((c) => `${c.agent.user.username}:${c.role}`).sort();

test("a forge with no agents gets the starter pair, seated, autonomy on as the asker", async () => {
  expect(await seatFirstAskCrew(app.db, repo, owner)).toBe(true);
  expect(seats()).toEqual(["builder:builder", "reviewer:reviewer"]);
  const fresh = getRepoById(app.db, repo.id)!;
  expect(fresh.autonomy).toBe("autonomous");
  expect(fresh.autonomyBy).toBe(owner);
});

test("a forge with its own agents keeps them and makes none", async () => {
  await agent("ada", ["builder"]);
  await agent("grace", ["reviewer"]);
  expect(await seatFirstAskCrew(app.db, repo, owner)).toBe(true);
  expect(seats()).toEqual(["ada:builder", "grace:reviewer"]);
  expect(listAgents(app.db).length).toBe(2);
});

test("a builder with no reviewer on the forge gets the starter reviewer beside them", async () => {
  await agent("ada", ["builder"]);
  expect(await seatFirstAskCrew(app.db, repo, owner)).toBe(true);
  expect(seats()).toEqual(["ada:builder", "reviewer:reviewer"]);
});

test("one agent holding both roles is not seated as their own reviewer", async () => {
  await agent("ada", ["builder", "reviewer"]);
  expect(await seatFirstAskCrew(app.db, repo, owner)).toBe(true);
  expect(seats()).toEqual(["ada:builder", "reviewer:reviewer"]);
});

test("a seat that cannot be filled returns false and leaves autonomy off", async () => {
  // A person already holds the name the starter reviewer would take.
  await agent("ada", ["builder"]);
  const p = await createUser(app.db, { origin: "seed", trusted: true, username: "reviewer", email: "r@x.test", password: "a-long-seating-passphrase" });
  expect(p.ok).toBe(true);
  expect(await seatFirstAskCrew(app.db, repo, owner)).toBe(false);
  expect(listCrewRoles(app.db, repo.id)).toEqual([]);
  expect(getRepoById(app.db, repo.id)!.autonomy).toBe("off");
});
