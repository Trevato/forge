import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { redMain } from "../src/checks/red_main.ts";
import { flakeList, flakeNeeds, passedAlone, recordCrashFlakes, recordFlakes, recordQueueFlakes, rerunCommand, rerunnable } from "../src/checks/flake.ts";
import { startChecks } from "../src/checks/service.ts";
import { parseBunTestFailure } from "../src/checks/bun-test.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const report = (names: string[], file = "t/a.test.ts"): string[] => [
  `${file}:`,
  ...names.map((n) => `(fail) ${n} [1.00ms]`),
  ` 0 pass`,
  ` ${names.length} fail`,
];

test("one or two named failures can be re-run; more, or a hook, cannot", () => {
  const one = report(["grp > flaky"]);
  expect(rerunnable(one, parseBunTestFailure(one))).toEqual([{ file: "t/a.test.ts", name: "grp > flaky", ms: 1 }]);
  const three = report(["a", "b", "c"]);
  expect(rerunnable(three, parseBunTestFailure(three))).toBeUndefined();
  const hook = ["t/a.test.ts:", "(fail) t/a.test.ts > beforeEach (timeout)", " 1 pass", " 1 fail"];
  expect(rerunnable(hook, parseBunTestFailure(hook))).toBeUndefined();
  expect(rerunnable(["tsc failed"], undefined)).toBeUndefined();
});

test("the re-run command quotes the name and anchors it to one test", () => {
  const cmd = rerunCommand({ file: "t/a.test.ts", name: "grp (x) > it's $(rm) a+b" });
  expect(cmd).toBe(`bun test 't/a.test.ts' -t '^grp \\(x\\) it'\\''s \\$\\(rm\\) a\\+b$'`);
});

test("a re-run that matched nothing or failed is not a pass", () => {
  expect(passedAlone([" 1 pass", " 0 fail"])).toBe(true);
  expect(passedAlone(['error: regex "x" matched 0 tests.'])).toBe(false);
  expect(passedAlone([" 0 pass", " 1 fail"])).toBe(false);
  // A pattern that caught a sibling too is not the one test passing.
  expect(passedAlone([" 2 pass", " 0 fail"])).toBe(false);
});

let dir: string;
let app: App;
let alice: Awaited<ReturnType<typeof makeUser>>;
async function makeUser() {
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  return u.value;
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "flake-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  alice = await makeUser();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("two flakes in a week file one issue for the test; a third adds none; the list counts them", async () => {
  const made = await createRepo(app, alice, { name: "list", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const repo = made.value;
  const t = [{ file: "t/a.test.ts", name: "grp > flaky" }];
  const issues = () => app.db.query<{ title: string; body: string }, [string]>("SELECT title, body FROM issue WHERE repo_id = ?1").all(repo.id);
  expect(recordFlakes(app.db, app.bus, repo, t, { runId: "r1", commit: "aaaaaaa1" })).toEqual([]);
  expect(issues().length).toBe(0);
  expect(recordFlakes(app.db, app.bus, repo, t, { runId: "r2", commit: "bbbbbbb2" }).length).toBe(1);
  expect(recordFlakes(app.db, app.bus, repo, t, { runId: "r3", commit: "ccccccc3" })).toEqual([]);
  expect(issues().length).toBe(1);
  expect(issues()[0]!.body).toContain("Files: t/a.test.ts");
  const list = flakeList(app.db, Date.now());
  expect(list[0]).toMatchObject({ repo: "alice/list", test: "grp > flaky", count: 3, lastCommit: "ccccccc3" });
  // A flake outside the week is not counted.
  expect(flakeList(app.db, Date.now() + 8 * 24 * 3_600_000)).toEqual([]);
});

const ft = (name: string, file?: string) => ({ failing: [{ name, ...(file === undefined ? {} : { file }) }] });

test("a queue flake keeps the verdict's one file, the tip and its gate; with no known file it is listed and files no issue", async () => {
  const made = await createRepo(app, alice, { name: "queued", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const repo = made.value;
  const issues = () => app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE repo_id = ?1").all(repo.id);
  const tip = "abcdef0123456789abcdef0123456789abcdef01";
  const known = [{ tests: ft("grp > known"), learn: ["t/k.test.ts"] }];
  recordQueueFlakes(app.db, app.bus, repo, known, tip);
  recordQueueFlakes(app.db, app.bus, repo, known, tip);
  expect(issues()).toHaveLength(1);
  expect(issues()[0]!.body).toContain("Files: t/k.test.ts");
  const row = app.db
    .query<{ run_id: string; commit_oid: string; file: string }, [string]>("SELECT run_id, commit_oid, file FROM check_flake WHERE repo_id = ?1 AND test = 'grp > known'")
    .get(repo.id)!;
  expect(row).toEqual({ run_id: "gate-abcdef012345", commit_oid: tip, file: "t/k.test.ts" });
  // Two files named, or none: the test is counted, no issue is filed.
  const vague = [{ tests: ft("grp > vague"), learn: ["t/x.test.ts", "t/y.test.ts"] }];
  recordQueueFlakes(app.db, app.bus, repo, vague, tip);
  recordQueueFlakes(app.db, app.bus, repo, vague, tip);
  recordQueueFlakes(app.db, app.bus, repo, [{ learn: [] }], tip);
  expect(issues()).toHaveLength(1);
  // A test that carries its own file files an issue though the verdicts learned several.
  recordQueueFlakes(app.db, app.bus, repo, [{ tests: ft("grp > own", "t/own.test.ts"), learn: ["t/x.test.ts", "t/y.test.ts"] }], tip);
  recordQueueFlakes(app.db, app.bus, repo, [{ tests: ft("grp > own", "t/own.test.ts"), learn: [] }], tip);
  expect(issues()).toHaveLength(2);
  expect(issues()[1]!.body).toContain("Files: t/own.test.ts");
  expect(flakeList(app.db, Date.now()).find((r) => r.test === "grp > vague")?.count).toBe(2);
});

test("a test that flaked three times in the week is an attention need; two is only a note", () => {
  const row = (count: number) => ({ repo: "a/b", test: "t", file: "f", count, lastCommit: "c", last: "" });
  expect(flakeNeeds([row(2)])).toEqual([]);
  expect(flakeNeeds([row(3)])).toEqual(["flaky: t failed and passed alone 3 times this week (a/b)"]);
});

/** A check whose full run prints one failing test and exits 1; the re-run is the real test file. */
async function mainCheck(name: string, testBody: string) {
  process.env["FORGE_CELLS"] = "off";
  const made = await createRepo(app, alice, { name, visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const repo = made.value;
  const fake = `printf 't/a.test.ts:\\n(fail) grp > flaky\\n 0 pass\\n 1 fail\\n'; exit 1`;
  const checks = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
  try {
    const pushed = await commitToBranch(app, alice, repo, {
      message: "a flaky main",
      files: [
        { path: "forge.json", content: JSON.stringify({ check: { run: fake, install: "" } }) },
        { path: "t/a.test.ts", content: `import { test, expect, describe } from "bun:test";\ndescribe("grp", () => { test("flaky", () => { ${testBody} }); });\n` },
      ],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const oid = pushed.value.commitOid;
    const deadline = Date.now() + 40_000;
    const finished = () => listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find((r) => r.commitOid === oid && (r.state === "ok" || r.state === "failed"));
    while (Date.now() < deadline && finished() === undefined) await Bun.sleep(100);
    if (finished() === undefined) throw new Error(`never came: still waiting while finished() === undefined`);
    const run = finished()!;
    return { repo, run, log: readRunLog(app.config.dataDir, run.id).lines.join("\n") };
  } finally {
    await checks.stop();
  }
}

test("a test that fails once and passes alone leaves main green and the flake recorded", async () => {
  const { repo, run, log } = await mainCheck("flaky", "expect(1).toBe(1);");
  expect(log).toContain("re-running 1 failed test(s) alone");
  expect(run.state).toBe("ok");
  expect(redMain(app.db, repo.id)).toBeUndefined();
  expect(flakeList(app.db, Date.now()).find((f) => f.repo === "alice/flaky")).toMatchObject({ test: "grp > flaky", file: "t/a.test.ts", count: 1 });
}, 60_000);

test("a test that fails alone too leaves main red", async () => {
  const { repo, run, log } = await mainCheck("broken", "expect(1).toBe(2);");
  expect(log).toContain("fails alone too: main is red");
  expect(run.state).toBe("failed");
  expect(redMain(app.db, repo.id)?.failing).toEqual(["grp > flaky"]);
  expect(flakeList(app.db, Date.now()).some((f) => f.repo === "alice/broken")).toBe(false);
}, 60_000);

test("a crash-flake line in a passing check's log is recorded as a file-less check_flake row; a failed check records nothing (#7781)", async () => {
  const made = await createRepo(app, alice, { name: "crashes", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const log = ["noise", "test-shards: crash flake 4/9: error: Cannot use a closed database #", "ok"];
  const rows = () => app.db.query<{ test: string; file: string }, [string]>("SELECT test, file FROM check_flake WHERE repo_id = ?1").all(made.value.id);
  expect(recordCrashFlakes(app.db, app.bus, made.value, log, { runId: "r1", commit: "aaaaaaa1" }, false)).toBe(0);
  expect(rows()).toEqual([]);
  expect(recordCrashFlakes(app.db, app.bus, made.value, log, { runId: "r2", commit: "bbbbbbb2", pull: true }, true)).toBe(1);
  expect(rows()).toEqual([{ test: "(crash outside any test) error: Cannot use a closed database #", file: "" }]);
});
