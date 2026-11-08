/**
 * Reading a cross-repo pull refreshes its head from the ref files (#8157):
 * an unmoved head spawns no git process, loose or packed, a moved one is
 * fetched, and a vanished branch leaves the last snapshot in place.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRole } from "../src/actions/roles.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { refreshPullHead } from "../src/core/following.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { resolveOid, writeRef } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";

let dataDir: string;
let app: App;
let parent: Repo;
let fork: Repo;
let ravi: User;
let number: number;

const mk = async (username: string, first: boolean): Promise<User> => {
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!u.ok) throw new Error(u.error);
  return u.value;
};

const pull = (): Pull => getPull(app.db, parent.id, number)!;
const baseDir = () => repoDir(app.reposRoot, parent.ownerName, parent.name);
const forkDir = () => repoDir(app.reposRoot, fork.ownerName, fork.name);
const snapshot = () => resolveOid(baseDir(), `refs/pull/${number}/head`);

/** How many processes `refreshPullHead` starts for one read. */
async function spawnsOf(): Promise<{ tip: string | undefined; spawns: number }> {
  const spy = spyOn(Bun, "spawn");
  try {
    const tip = await refreshPullHead(app, parent, pull());
    return { tip, spawns: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-head-"));
  app = createApp({ dataDir, port: 0 });
  const admin = await mk("hank", true);
  const olive = await mk("olive", false);
  ravi = await mk("ravi", false);
  for (const name of ["olive", "ravi"]) {
    const promoted = setRole(app, admin, name, "member");
    if (!promoted.ok) throw new Error(promoted.error);
  }
  const r = await createRepo(app, olive, { name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  await commitToBranch(app, olive, r.value, {
    message: "first",
    files: [{ path: "a.txt", content: "a\n" }],
  });
  const f = await forkRepo(app, ravi, r.value);
  if (!f.ok) throw new Error(String(f.error));
  parent = getRepo(app.db, "olive", "yard")!;
  fork = getRepo(app.db, "ravi", "yard")!;
  const side = await commitToBranch(app, ravi, fork, {
    message: "side",
    branch: "side",
    files: [{ path: "side.txt", content: "s\n" }],
  });
  if (!side.ok) throw new Error(JSON.stringify(side.error));
  const opened = await openPull(app, ravi, parent, {
    title: "Side",
    body: "",
    baseBranch: "main",
    headBranch: "side",
    headRepo: fork,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  number = opened.value.number;
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an unmoved head, read from loose refs, spawns no git process", async () => {
  expect(pull().crossRepo).toBe(true);
  expect(await snapshot()).toBe(await resolveOid(forkDir(), "refs/heads/side"));
  expect(await spawnsOf()).toEqual({ tip: undefined, spawns: 0 });
});

test("a moved head is fetched into the base's snapshot", async () => {
  const before = (await snapshot())!;
  const next = await commitToBranch(app, ravi, fork, {
    message: "more",
    branch: "side",
    files: [{ path: "more.txt", content: "m\n" }],
  });
  if (!next.ok) throw new Error(JSON.stringify(next.error));
  const live = (await resolveOid(forkDir(), "refs/heads/side"))!;
  // Put the snapshot back where it was, as if the push had not been followed.
  expect(await writeRef(baseDir(), `refs/pull/${number}/head`, before)).toBe(true);
  const { tip, spawns } = await spawnsOf();
  expect(tip).toBe(live);
  expect(spawns).toBeGreaterThan(0);
  expect(await snapshot()).toBe(live);
  expect(pull().headOid).toBe(live);
}, 30_000);

test("packed refs on both sides answer the same, still without a process", async () => {
  for (const dir of [baseDir(), forkDir()]) {
    const packed = await runGit(["pack-refs", "--all"], { cwd: dir });
    expect(packed.ok).toBe(true);
    expect(await Bun.file(join(dir, `refs/pull/${number}/head`)).exists()).toBe(false);
    expect(await Bun.file(join(dir, "refs/heads/side")).exists()).toBe(false);
  }
  expect(await spawnsOf()).toEqual({ tip: undefined, spawns: 0 });
  // A loose snapshot behind a packed head still sees the difference.
  const live = (await resolveOid(forkDir(), "refs/heads/side"))!;
  const first = await runGit(["rev-parse", "side~1"], { cwd: forkDir() });
  if (!first.ok) throw new Error(first.error.stderr);
  expect(await writeRef(baseDir(), `refs/pull/${number}/head`, first.value)).toBe(true);
  expect((await spawnsOf()).tip).toBe(live);
  expect(await snapshot()).toBe(live);
}, 30_000);

test("a vanished branch leaves the last snapshot in place", async () => {
  const kept = await snapshot();
  const gone = await runGit(["update-ref", "-d", "refs/heads/side"], { cwd: forkDir() });
  expect(gone.ok).toBe(true);
  expect((await spawnsOf()).tip).toBeUndefined();
  expect(await snapshot()).toBe(kept);
}, 30_000);
