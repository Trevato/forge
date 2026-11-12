/**
 * The sync contract at the doors a person and an agent use (#9560): a fork's
 * standing against its parent names the one action that reconciles it (API,
 * web card, terminal row), and taking the parent's work goes through
 * `syncLink`, staging the parent's tip and refusing a divergence.
 *
 * Nothing here sleeps: a parent commit that must not be followed is written
 * with git directly (no push event, so no follow-on), and one that is
 * followed is awaited through the event the follow-on emits.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { fastForwardFork, forkRelation } from "../src/core/following.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { followingRows } from "../src/tui/screens/forks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";
let parent: Repo;
let fork: Repo;
const cells = process.env["FORGE_CELLS"];

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const commit = async (repo: Repo, path: string, content: string) =>
  ok(await commitToBranch(app, alice, repo, { message: path, files: [{ path, content }] }));
/** A commit (same tree, new message) on `repo`'s main written with git alone: no push event, so nothing follows it. */
const quietCommit = async (repo: Repo, file: string): Promise<string> => {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const g = async (...args: string[]) => {
    const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd: dir });
    if (!r.ok) throw new Error(r.error.stderr);
    return r.value.trim();
  };
  const base = await g("rev-parse", "refs/heads/main");
  const made = await g("commit-tree", `${base}^{tree}`, "-p", base, "-m", file);
  await g("update-ref", "refs/heads/main", made, base);
  return made;
};
/** Resolves with the next event of `kind` on `repoId`. */
const next = (kind: string, repoId: string): Promise<void> =>
  new Promise((resolve) => {
    const off = app.bus.subscribe((e) => {
      if (e.kind === kind && e.repoId === repoId) {
        off();
        resolve();
      }
    });
  });
const read = async (): Promise<{ action: string; words: string; state: string }> =>
  (await (await fetch(`${servers.url}/api/v1/repos/alice/kid/following`, { headers: { cookie } })).json()) as never;

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-fork-reconcile-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true }));
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  parent = ok(await createRepo(app, alice, { name: "root", visibility: "public" }));
  await commit(parent, "a.txt", "1\n");
  fork = ok(await forkRepo(app, alice, parent, "kid"));
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("every standing names its action, at the API, the terminal row and the web card", async () => {
  expect(await read()).toMatchObject({ state: "synced", action: "none" });
  await quietCommit(parent, "b.txt");
  const behind = await forkRelation(app, getRepo(app.db, "alice", "kid")!);
  expect(behind).toMatchObject({ state: "behind", action: "fast-forward" });
  expect(followingRows(behind, undefined)[0]!.words).toContain("fast-forward");
  const page = await (await fetch(`${servers.url}/alice/kid`, { headers: { cookie } })).text();
  expect(page).toContain("take them in, nothing of ours is lost");
});

test("taking the parent's work stages its tip, moves once, and refuses a divergence", async () => {
  fork = getRepo(app.db, "alice", "kid")!;
  const forkDir = repoDir(app.reposRoot, "alice", "kid");
  const [first, again] = await Promise.all([
    fastForwardFork(app, fork, parent, alice.id),
    fastForwardFork(app, fork, parent, alice.id),
  ]).then((rs) => rs.map(ok));
  // Taken at once, they take turns: one moves, the other finds it done.
  expect([first!.updated, again!.updated].sort()).toEqual([false, true]);
  const moved = first!.updated ? first! : again!;
  const staged = await runGit(["rev-parse", "refs/following/main"], { cwd: forkDir });
  expect(staged.ok && staged.value.trim()).toBe(moved.to);
  expect(ok(await fastForwardFork(app, fork, parent, alice.id)).updated).toBe(false);
  await commit(fork, "mine.txt", "x\n");
  // The parent's push starts the follow-on; it finds the fork diverged and says so.
  const told = next("fork.diverged", fork.id);
  await commit(parent, "c.txt", "3\n");
  await told;
  expect(await fastForwardFork(app, fork, parent, alice.id)).toEqual({ ok: false, error: "diverged" });
  expect(await read()).toMatchObject({ state: "diverged", action: "merge" });
});
