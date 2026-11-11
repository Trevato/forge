/**
 * Boot heals pull heads from refs (#9935): a branch moved behind the index's
 * back — git written to directly, no hook, no event — is what `reconcile`
 * finds and repairs, through `trackPullHead`, with one `push` event. A second
 * run finds nothing. A pull whose branch is gone is left as it is.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull } from "../src/core/pulls.ts";
import { reconcile } from "../src/core/reconcile.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User;
let repo: Repo;
let moved = 0;
let gone = 0;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const git = async (...args: string[]): Promise<string> => {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd: dir });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value.trim();
};
const pushEvents = (): { payload: string }[] =>
  app.db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM event WHERE repo_id = ?1 AND kind = 'push' ORDER BY rowid",
    )
    .all(repo.id);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-reconcile-heads-"));
  app = createApp({ dataDir, port: 0 });
  alice = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true }));
  repo = ok(await createRepo(app, alice, { name: "heads", visibility: "public" }));
  ok(await commitToBranch(app, alice, repo, { message: "init", files: [{ path: "README.md", content: "x" }] }));
  for (const branch of ["topic", "doomed"]) {
    ok(await commitToBranch(app, alice, repo, { branch, message: branch, files: [{ path: `${branch}.txt`, content: "x" }] }));
    const pull = ok(await openPull(app, alice, repo, { title: branch, body: "", baseBranch: "main", headBranch: branch }));
    if (branch === "topic") moved = pull.number;
    else gone = pull.number;
  }
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a branch moved behind the index's back moves its pull's head, once", async () => {
  const before = getPull(app.db, repo.id, moved)!.headOid;
  const doomedBefore = getPull(app.db, repo.id, gone)!.headOid;
  const made = await git("commit-tree", `${before}^{tree}`, "-p", before, "-m", "behind the index");
  await git("update-ref", "refs/heads/topic", made, before);
  await git("update-ref", "-d", "refs/heads/doomed");
  const events = pushEvents().length;

  await reconcile(app);

  expect(getPull(app.db, repo.id, moved)!.headOid).toBe(made);
  const after = pushEvents();
  expect(after.length).toBe(events + 1);
  const payload = JSON.parse(after.at(-1)!.payload) as { updates: { ref: string; oldOid: string; newOid: string }[] };
  expect(payload.updates).toEqual([{ ref: "refs/heads/topic", oldOid: before, newOid: made }]);
  // The missing branch leaves its row as it was.
  expect(getPull(app.db, repo.id, gone)!.headOid).toBe(doomedBefore);

  await reconcile(app);
  expect(getPull(app.db, repo.id, moved)!.headOid).toBe(made);
  expect(pushEvents().length).toBe(events + 1);
});
