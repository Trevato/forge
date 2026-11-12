/** The reads a display lists from: admin-owned repos, readable ids, dates, all repos by owner (#9273). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import {
  listAdminOwnedRepos,
  listAllReposByOwner,
  readableRepoIds,
  repoDatesFor,
  type Repo,
} from "../src/core/repos.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let root: User;
let alice: User;
let bob: User;
const repos: Record<string, Repo> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-display-reads-"));
  app = createApp({ dataDir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, allowReserved: true,
      email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  root = await mk("root", true);
  alice = await mk("alice");
  bob = await mk("bob");
  const make = async (key: string, who: User, name: string, visibility: "public" | "private") => {
    const r = await createRepo(app, who, { name, visibility });
    if (!r.ok) throw new Error(`${key}: ${r.error}`);
    repos[key] = r.value;
  };
  await make("rootPub", root, "rootpub", "public");
  await make("rootPriv", root, "rootpriv", "private");
  await make("a1", alice, "one", "public");
  await make("a2", alice, "two", "private");
  await make("a3", alice, "three", "public");
  await make("bobPriv", bob, "bobs", "private");
});
afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("display reads", () => {
  test("listAdminOwnedRepos lists only repositories an admin owns", () => {
    const names = listAdminOwnedRepos(app.db).map((r) => `${r.ownerName}/${r.name}`);
    expect(names.every((n) => n.startsWith("root/"))).toBe(true);
    expect(names.sort()).toEqual(["root/rootpriv", "root/rootpub"]);
  });

  test("readableRepoIds excludes a private repository the viewer cannot read", () => {
    const ids = Object.values(repos).map((r) => r.id);
    const mine = readableRepoIds(app.db, alice, ids);
    expect(mine.has(repos.a2!.id)).toBe(true);
    expect(mine.has(repos.rootPub!.id)).toBe(true);
    expect(mine.has(repos.bobPriv!.id)).toBe(false);
    expect(mine.has(repos.rootPriv!.id)).toBe(false);
    const anon = readableRepoIds(app.db, undefined, ids);
    expect([...anon].sort()).toEqual([repos.rootPub!.id, repos.a1!.id, repos.a3!.id].sort());
    expect(readableRepoIds(app.db, alice, []).size).toBe(0);
  });

  test("listAllReposByOwner honours its limit and ignores visibility", () => {
    expect(listAllReposByOwner(app.db, "alice", 10).length).toBe(3);
    expect(listAllReposByOwner(app.db, "ALICE", 2).length).toBe(2);
    expect(listAllReposByOwner(app.db, "nobody", 5)).toEqual([]);
  });

  test("repoDatesFor returns one entry per id asked", () => {
    const ids = [repos.a1!.id, repos.a2!.id, repos.a1!.id];
    const dates = repoDatesFor(app.db, [...ids, "missing"]);
    expect([...dates.keys()].sort()).toEqual([repos.a1!.id, repos.a2!.id].sort());
    expect(dates.get(repos.a1!.id)!.createdAt).toBeTruthy();
    expect(repoDatesFor(app.db, []).size).toBe(0);
  });
});
