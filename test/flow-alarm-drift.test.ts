/** The drifting-pull alarm: 26 landings fires, 25 does not; merged or closed pulls never count. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { setIssueState } from "../src/core/issues.ts";
import { createPull } from "../src/core/pulls.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { alarmDrift, driftAlarm } from "../src/flow/alarm_drift.ts";
import { repoDir } from "../src/git/repos.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const NOW = Date.UTC(2026, 9, 26, 12);
const HOUR = 3_600_000;
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

test("by landings: more than 25 fires, 25 does not", () => {
  const at = (landings: number) => driftAlarm([{ number: 7, landings, since: NOW - 60_000 }], NOW);
  expect(at(25).fired).toBe(false);
  const fired = at(26);
  expect(fired.fired).toBe(true);
  expect(fired.says).toBe("#7 is 26 landings behind main.");
});

test("by hours: past 6 h fires; says the three most behind", () => {
  const a = driftAlarm(
    [
      { number: 1, landings: 2, since: NOW - 6 * HOUR },
      { number: 2, landings: 2, since: NOW - 7 * HOUR },
      { number: 3, landings: 41, since: NOW - HOUR },
      { number: 4, landings: 30, since: NOW - HOUR },
      { number: 5, landings: 26, since: NOW - HOUR },
    ],
    NOW,
  );
  expect(a.fired).toBe(true);
  expect(a.says).toBe("#3 is 41 landings behind main; #4 is 30 landings behind main; #5 is 26 landings behind main; and 1 more.");
  expect(a.since).toBe(new Date(NOW - 7 * HOUR).toISOString());
  const h = driftAlarm([{ number: 2, landings: 2, since: NOW - 7 * HOUR }], NOW);
  expect(h.says).toBe("#2 is 7h behind.");
  expect(driftAlarm([{ number: 1, landings: 2, since: NOW - 6 * HOUR }], NOW).fired).toBe(false);
  expect(driftAlarm([], NOW)).toEqual({ fired: false, says: "No open pull is drifting from main." });
});

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-drift-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("read from git: landings past a pull's base, open pulls only", async () => {
  const ada = ok(
    await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "a-good-passphrase", adminIfFirst: true }),
  );
  const repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "svc", visibility: "public" }));
  const dir = repoDir(app.reposRoot, ada.username, repo.name);
  const land = async (n: number) => {
    for (let i = 0; i < n; i++)
      ok(await commitToBranch(app, ada, repo, { message: `m${i}`, files: [{ path: `f${Math.random()}.txt`, content: "x\n" }] }));
  };
  await land(1);
  const branch = (b: string) =>
    commitToBranch(app, ada, repo, { message: b, branch: b, files: [{ path: `${b}.txt`, content: "x\n" }] } as any);
  ok(await branch("one"));
  ok(await branch("two"));
  const open = ok(await createPull(app.db, dir, { repoId: repo.id, authorId: ada.id, title: "one", baseBranch: "main", headBranch: "one" }));
  const shut = ok(await createPull(app.db, dir, { repoId: repo.id, authorId: ada.id, title: "two", baseBranch: "main", headBranch: "two" }));
  await land(25);
  expect((await alarmDrift(app, new Date())).fired).toBe(false);
  await land(1);
  const fired = await alarmDrift(app, new Date());
  expect(fired.fired).toBe(true);
  expect(fired.says).toContain(`#${open.number} is 26 landings`);
  const both = await alarmDrift(app, new Date(Date.now()));
  expect(both.says).toBe(`#${open.number} is 26 landings behind main; #${shut.number} is 26 landings behind main.`);
  setIssueState(app.db, shut.id, "closed");
  const one = await alarmDrift(app, new Date(Date.now()));
  expect(one.says).toBe(`#${open.number} is 26 landings behind main.`);
  setIssueState(app.db, open.id, "closed");
});

test("a rebased head stops counting; a merged pull never counts", async () => {
  const ada = ok(
    await createUser(app.db, { origin: "seed", trusted: true, username: "bo", email: "bo@forge.local", password: "a-good-passphrase" }),
  );
  const repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "rb", visibility: "public" }));
  const dir = repoDir(app.reposRoot, ada.username, repo.name);
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    return (await new Response(p.stdout).text()).trim();
  };
  ok(await commitToBranch(app, ada, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  ok(await commitToBranch(app, ada, repo, { message: "w", branch: "work", files: [{ path: "w.txt", content: "w\n" }] } as any));
  const pull = ok(await createPull(app.db, dir, { repoId: repo.id, authorId: ada.id, title: "w", baseBranch: "main", headBranch: "work" }));
  for (let i = 0; i < 26; i++)
    ok(await commitToBranch(app, ada, repo, { message: `m${i}`, files: [{ path: `g${i}.txt`, content: "x\n" }] }));
  expect((await alarmDrift(app, new Date())).fired).toBe(true);
  // Merge main into the head and tell the pull, as a push does.
  const merged = await git("commit-tree", "main^{tree}", "-p", "work", "-p", "main", "-m", "merge main");
  expect(merged).toMatch(/^[0-9a-f]{40}$/);
  await git("update-ref", "refs/heads/work", merged);
  app.db.query("UPDATE pull SET head_oid = ?1 WHERE issue_id = ?2").run(merged, pull.id);
  expect((await alarmDrift(app, new Date())).fired).toBe(false);
  // Behind again, but merged: never counts.
  for (let i = 0; i < 26; i++)
    ok(await commitToBranch(app, ada, repo, { message: `n${i}`, files: [{ path: `h${i}.txt`, content: "x\n" }] }));
  expect((await alarmDrift(app, new Date())).fired).toBe(true);
  app.db.query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2").run(new Date().toISOString(), pull.id);
  expect((await alarmDrift(app, new Date())).fired).toBe(false);
});
