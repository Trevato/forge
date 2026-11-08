/**
 * "Fetch now" on a prompt source (`runPromptSource`): an admin's press runs
 * the routine once; no routine, an unknown or foreign source, or a writer
 * who is not an admin runs nothing. Instagram is a stub that counts calls.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromptSource } from "../src/actions/prompts.ts";
import { createOrg, createTeam, addTeamMember } from "../src/actions/orgs.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getOrg } from "../src/core/orgs.ts";
import { addPromptSource } from "../src/core/prompts.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  startPromptRoutine,
  type PromptRoutineHandle,
} from "../src/crew/prompts.ts";
import type { InstagramClient } from "../src/crew/instagram.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let bare: App;
let bareDir: string;
let routine: PromptRoutineHandle;
let alice: User;
let bob: User;
let repo: Repo;
let other: Repo;
let sourceId = "";
let otherSourceId = "";
let bareSourceId = "";
let bareRepo: Repo;
let bareAlice: User;
let fetches = 0;

/** Counts `me` calls: one run asks Instagram who it is exactly once. */
const instagram: InstagramClient = {
  me: () => {
    fetches += 1;
    return Promise.resolve({ id: "1", username: "handle" });
  },
  latestReel: () => Promise.resolve(undefined),
  comments: () => Promise.resolve([]),
  refresh: () => Promise.resolve({ token: "fresh" }),
};

const user = async (a: App, username: string, adminIfFirst = false): Promise<User> => {
  const made = await createUser(a.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

const source = (a: App, repoId: string, token: string, by: User): string => {
  const added = addPromptSource(a.db, a === app ? dataDir : bareDir, {
    repoId,
    kind: "instagram",
    token,
    atUtc: "09:00",
    createdBy: by.id,
  });
  if (!added.ok) throw new Error(added.error);
  return added.value.id;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fetchnow-"));
  bareDir = await mkdtemp(join(tmpdir(), "forge-fetchnow-bare-"));
  app = createApp({ dataDir, port: 0 });
  bare = createApp({ dataDir: bareDir, port: 0 });
  routine = startPromptRoutine(app, {
    client: instagram,
    everyMs: 3_600_000,
  });
  alice = await user(app, "alice", true);
  bob = await user(app, "bob");

  const org = createOrg(app, alice, "acme");
  if (!org.ok) throw new Error(org.error);
  const acme = getOrg(app.db, "acme")!;
  const devs = createTeam(app, alice, acme, "devs", "write");
  if (!devs.ok) throw new Error(devs.error);
  addTeamMember(app, alice, acme, devs.value, "bob");
  const made = await createRepo(app, alice, {
    owner: "acme",
    name: "game",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const second = await createRepo(app, alice, {
    name: "elsewhere",
    visibility: "public",
  });
  if (!second.ok) throw new Error(String(second.error));
  other = second.value;
  sourceId = source(app, repo.id, "token-one", alice);
  otherSourceId = source(app, other.id, "token-two", alice);

  bareAlice = await user(bare, "alice", true);
  const bareMade = await createRepo(bare, bareAlice, {
    name: "game",
    visibility: "public",
  });
  if (!bareMade.ok) throw new Error(String(bareMade.error));
  bareRepo = bareMade.value;
  bareSourceId = source(bare, bareRepo.id, "token-three", bareAlice);
});

afterAll(async () => {
  await routine.stop();
  app.close();
  bare.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(bareDir, { recursive: true, force: true });
});

describe("Fetch now", () => {
  test("an admin's press runs the routine once", async () => {
    fetches = 0;
    const ran = await runPromptSource(app, alice, repo, sourceId);
    expect(ran.ok).toBe(true);
    if (ran.ok) {
      expect(ran.value.id).toBe(sourceId);
      expect(ran.value.account).toBe("handle");
    }
    expect(fetches).toBe(1);
  });

  test("a forge with no prompts routine answers not_running and fetches nothing", async () => {
    fetches = 0;
    const ran = await runPromptSource(bare, bareAlice, bareRepo, bareSourceId);
    expect(ran).toEqual({ ok: false, error: "not_running" });
    expect(fetches).toBe(0);
  });

  test("another repository's source is no_such_source and nothing runs", async () => {
    fetches = 0;
    const ran = await runPromptSource(app, alice, repo, otherSourceId);
    expect(ran).toEqual({ ok: false, error: "no_such_source" });
    expect(await runPromptSource(app, alice, repo, "nope")).toEqual({
      ok: false,
      error: "no_such_source",
    });
    expect(fetches).toBe(0);
  });

  test("a writer who is not an admin is refused and nothing runs", async () => {
    fetches = 0;
    const ran = await runPromptSource(app, bob, repo, sourceId);
    expect(ran.ok).toBe(false);
    expect(fetches).toBe(0);
    const anon = await runPromptSource(app, undefined, repo, sourceId);
    expect(anon.ok).toBe(false);
    expect(fetches).toBe(0);
  });
});
