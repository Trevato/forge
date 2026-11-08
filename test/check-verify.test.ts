/**
 * The checks service verifies main after landing (#7786): `verifyDue`
 * asks for a run of the declared `check.verify` on main's checked tip, once
 * per move of main; a red that fails alone too names the commit that broke
 * it — here a push no pull carried, so one issue.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { VERIFY_ENV } from "../src/checks/verify.ts";
import type { Repo } from "../src/core/repos.ts";
import { getRun, listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let repo: Repo;
let checks: ChecksHandle;

const report = (fail: boolean): string =>
  fail
    ? `printf 't/a.test.ts:\\n(fail) grp > works\\n 0 pass\\n 1 fail\\n'; exit 1`
    : `printf 't/a.test.ts:\\n(pass) grp > works\\n 1 pass\\n 0 fail\\n'`;

async function push(fail: boolean, note = ""): Promise<string> {
  const pushed = await commitToBranch(app, alice, repo, {
    message: fail ? "breaks it" : "works",
    files: [
      { path: "forge.json", content: JSON.stringify({ check: { run: "true", verify: report(fail), install: "" } }) },
      {
        path: "t/a.test.ts",
        content: `${note}import { test, expect, describe } from "bun:test";\ndescribe("grp", () => { test("works", () => { expect(${fail ? 2 : 1}).toBe(1); }); });\n`,
      },
    ],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  return pushed.value.commitOid;
}

async function until<T>(read: () => T | undefined, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

const finished = (env: string, oid: string): Run | undefined =>
  listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
    (r) => r.env === env && r.commitOid === oid && (r.state === "ok" || r.state === "failed"),
  );

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dir = await mkdtemp(join(tmpdir(), "check-verify-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const made = await createRepo(app, alice, { name: "verified", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  repo = made.value;
  checks = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
});
afterAll(async () => {
  await checks.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a green main is verified once; asked again before it moves, it is not", async () => {
  const oid = await push(false);
  await until(() => finished(repo.defaultBranch, oid));
  const asked = await checks.verifyDue();
  expect(asked.map((r) => [r.env, r.commitOid])).toEqual([[VERIFY_ENV, oid]]);
  const run = await until(() => finished(VERIFY_ENV, oid));
  expect(run.state).toBe("ok");
  expect(await checks.verifyDue()).toEqual([]);
}, 60_000);

test("a red verification that fails alone too names the push that broke it in one issue", async () => {
  const oid = await push(true);
  await until(() => finished(repo.defaultBranch, oid));
  // Main moved, but the last verification is not 30 minutes old yet.
  expect(await checks.verifyDue()).toEqual([]);
  const asked = await checks.verifyDue(Date.now() + 31 * 60_000);
  expect(asked).toHaveLength(1);
  const run = await until(() => finished(VERIFY_ENV, oid));
  expect(run.state).toBe("failed");
  expect(getRun(app.db, run.id)?.checkDetail?.files).toEqual(["t/a.test.ts"]);
  // The service filled the failures and filed the report for the failing file.
  expect(getRun(app.db, run.id)?.checkDetail?.failures).toEqual([{ file: "t/a.test.ts", name: "grp > works" }]);
  const reported = await until(() =>
    app.db
      .query<{ body: string }, [string]>("SELECT body FROM issue WHERE repo_id = ?1 AND title = 'Full suite red: t/a.test.ts'")
      .get(repo.id) ?? undefined,
  );
  expect(reported.body).toContain("grp > works");
  const issue = await until(() =>
    app.db
      .query<{ title: string; body: string }, [string]>("SELECT title, body FROM issue WHERE repo_id = ?1 AND kind = 'issue' AND title LIKE 'Red after landing:%'")
      .get(repo.id) ?? undefined,
  );
  expect(issue.title).toContain(oid.slice(0, 7));
  const log = readRunLog(app.config.dataDir, run.id).lines.join("\n");
  expect(log).toContain("fails alone too");
  expect(log).toContain("landed by no pull");
}, 60_000);

test("a later green verification closes the report's issue for the file it passed (#9524)", async () => {
  // A tree never proven green before: a proven one is not run again, and prints no file.
  const oid = await push(false, "// fixed\n");
  await until(() => finished(repo.defaultBranch, oid));
  expect(await checks.verifyDue(Date.now() + 62 * 60_000)).toHaveLength(1);
  const run = await until(() => finished(VERIFY_ENV, oid));
  expect(run.state).toBe("ok");
  const closed = await until(() =>
    app.db
      .query<{ id: string; state: string; close_reason: string | null }, [string]>(
        "SELECT id, state, close_reason FROM issue WHERE repo_id = ?1 AND title = 'Full suite red: t/a.test.ts' AND state = 'closed'",
      )
      .get(repo.id) ?? undefined,
  );
  expect(closed.close_reason).toBe("done");
  const said = app.db
    .query<{ body: string }, [string]>("SELECT body FROM comment WHERE issue_id = ?1")
    .all(closed.id)
    .map((c) => c.body);
  expect(said).toContain(`Green again in the full suite (check run ${run.id}, ${oid.slice(0, 7)}).`);
  // The culprit's issue is not the report's: it stays open.
  const culprit = app.db
    .query<{ state: string }, [string]>("SELECT state FROM issue WHERE repo_id = ?1 AND title LIKE 'Red after landing:%'")
    .get(repo.id);
  expect(culprit?.state).toBe("open");
  expect(readRunLog(app.config.dataDir, run.id).lines.join("\n")).toContain("t/a.test.ts green again");
}, 60_000);
