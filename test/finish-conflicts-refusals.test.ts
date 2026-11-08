/**
 * Finishing a conflict from the forge (#7088): one conflicted file and its
 * resolution makes the pull mergeable; a stale page, a pull with no conflict
 * and a path that is not the one conflicting file are each refused, and the
 * head branch is untouched after every refusal.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { finishConflicts } from "../src/actions/finish-conflicts.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { pullStatus, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";

let dataDir: string;
let app: App;
let alice: User;
let n = 0;

const ours = { kind: "ours" } as const;

async function commit(repo: Repo, branch: string, files: Record<string, string>, base?: string) {
  const r = await commitToBranch(app, alice, repo, {
    branch,
    ...(base ? { base } : {}),
    message: `Write ${Object.keys(files).join(", ")}`,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

/** A repo with a pull whose head and main each rewrote every file in `files`. */
async function conflicted(files: string[]): Promise<{ repo: Repo; pull: Pull; dir: string }> {
  const made = await createRepo(app, alice, { name: `r${++n}`, visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  await commit(repo, "main", Object.fromEntries(files.map((f) => [f, "line\n"])));
  await commit(repo, "feature", Object.fromEntries(files.map((f) => [f, "feature\n"])), "main");
  await commit(repo, "main", Object.fromEntries(files.map((f) => [f, "main\n"])));
  const opened = await openPull(app, alice, repo, {
    title: "Conflicts",
    body: "",
    baseBranch: "main",
    headBranch: "feature",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return { repo, pull: opened.value, dir };
}

/** What the page read: the live tips. */
async function seen(dir: string, pull: Pull) {
  const s = await pullStatus(dir, pull);
  return { headOid: s.headOid, baseOid: s.baseOid, status: s };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-finish-refusals-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a pull that conflicts on one file is finished with that file's resolution and merges", async () => {
  const { repo, pull, dir } = await conflicted(["a.txt"]);
  const { headOid, baseOid, status } = await seen(dir, pull);
  expect(status.conflicts).toEqual(["a.txt"]);
  expect(status.mergeable).toBe(false);
  const done = await finishConflicts(app, alice, repo, pull, {
    headOid,
    baseOid,
    path: "a.txt",
    choices: [ours],
  });
  expect(done.ok).toBe(true);
  const after = await pullStatus(dir, pull);
  expect(after.mergeable).toBe(true);
  expect(after.conflicts).toEqual([]);
  expect(after.headOid).not.toBe(headOid);
});

test("a head that moved since the page was read is stale", async () => {
  const { repo, pull, dir } = await conflicted(["a.txt"]);
  const { headOid, baseOid } = await seen(dir, pull);
  await commit(repo, "feature", { "a.txt": "feature again\n" });
  const moved = (await pullStatus(dir, pull)).headOid;
  const r = await finishConflicts(app, alice, repo, pull, { headOid, baseOid, path: "a.txt", choices: [ours] });
  expect(r).toEqual({ ok: false, error: "stale" });
  expect((await pullStatus(dir, pull)).headOid).toBe(moved);
});

test("a base that moved since the page was read is stale", async () => {
  const { repo, pull, dir } = await conflicted(["a.txt"]);
  const { headOid, baseOid } = await seen(dir, pull);
  await commit(repo, "main", { "b.txt": "elsewhere\n" });
  const r = await finishConflicts(app, alice, repo, pull, { headOid, baseOid, path: "a.txt", choices: [ours] });
  expect(r).toEqual({ ok: false, error: "stale" });
  expect((await pullStatus(dir, pull)).headOid).toBe(headOid);
});

test("a pull with no conflict is refused as no_conflicts", async () => {
  const made = await createRepo(app, alice, { name: `r${++n}`, visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  await commit(repo, "main", { "a.txt": "line\n" });
  await commit(repo, "feature", { "b.txt": "new\n" }, "main");
  const opened = await openPull(app, alice, repo, {
    title: "Clean",
    body: "",
    baseBranch: "main",
    headBranch: "feature",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const { headOid, baseOid, status } = await seen(dir, opened.value);
  expect(status.conflicts).toEqual([]);
  const r = await finishConflicts(app, alice, repo, opened.value, { headOid, baseOid, path: "a.txt", choices: [ours] });
  expect(r).toEqual({ ok: false, error: "no_conflicts" });
  expect((await pullStatus(dir, opened.value)).headOid).toBe(headOid);
});

test("a path that is not the conflicting file is not_resolvable", async () => {
  const { repo, pull, dir } = await conflicted(["a.txt"]);
  const { headOid, baseOid } = await seen(dir, pull);
  const r = await finishConflicts(app, alice, repo, pull, { headOid, baseOid, path: "other.txt", choices: [ours] });
  expect(r).toEqual({ ok: false, error: "not_resolvable" });
  expect((await pullStatus(dir, pull)).headOid).toBe(headOid);
});

test("a pull that conflicts on two files is not_resolvable, whichever path is sent", async () => {
  const { repo, pull, dir } = await conflicted(["a.txt", "b.txt"]);
  const { headOid, baseOid, status } = await seen(dir, pull);
  expect(status.conflicts.length).toBe(2);
  for (const path of ["a.txt", "b.txt"]) {
    const r = await finishConflicts(app, alice, repo, pull, { headOid, baseOid, path, choices: [ours] });
    expect(r).toEqual({ ok: false, error: "not_resolvable" });
    expect((await pullStatus(dir, pull)).headOid).toBe(headOid);
  }
});
