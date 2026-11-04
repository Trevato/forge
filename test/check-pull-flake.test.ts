import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { recordFlakes, flakeList, pullOwnsRed, touchedByPull } from "../src/checks/flake.ts";
import { startChecks } from "../src/checks/service.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

test("a test is the pull's when it, or anything it imports, changed; unreadable is the pull's too", () => {
  const files: Record<string, string> = {
    "t/a.test.ts": `import { h } from "./helper.ts";\nimport "../src/x";`,
    "t/helper.ts": `export const h = 1;`,
    "src/x.ts": `import { y } from "./y.ts";`,
    "src/y.ts": ``,
  };
  const read = (p: string) => files[p];
  expect(touchedByPull("t/a.test.ts", ["README.md"], read)).toBe(false);
  expect(touchedByPull("t/a.test.ts", ["t/a.test.ts"], read)).toBe(true);
  expect(touchedByPull("t/a.test.ts", ["t/helper.ts"], read)).toBe(true);
  expect(touchedByPull("t/a.test.ts", ["src/y.ts"], read)).toBe(true);
  expect(touchedByPull("t/a.test.ts", ["package.json"], read)).toBe(true);
  expect(touchedByPull("t/gone.test.ts", ["README.md"], read)).toBe(true);
  expect(touchedByPull("t/a.test.ts", ["README.md"], (p) => (p === "src/y.ts" ? undefined : files[p]))).toBe(true);
});

test("with no list of changed paths (the diff failed) the pull owns the red", () => {
  const read = () => "";
  const tests = [{ file: "t/a.test.ts", name: "x" }];
  expect(pullOwnsRed(tests, undefined, read)).toBe(true);
  expect(pullOwnsRed(tests, ["README.md"], read)).toBe(false);
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
  dir = await mkdtemp(join(tmpdir(), "pull-flake-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  alice = await makeUser();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const spec = (body: string) => `import { test, expect, describe } from "bun:test";\ndescribe("grp", () => { test("flaky", () => { ${body} }); });\n`;

/** A pull whose check prints `names` as failed in t/a.test.ts and exits 1; the branch writes `branchFiles`. */
async function pullCheck(name: string, names: string[], branchFiles: { path: string; content: string }[]) {
  process.env["FORGE_CELLS"] = "off";
  const made = await createRepo(app, alice, { name, visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const repo = made.value;
  const fails = names.map((n) => `(fail) ${n}\\n`).join("");
  const fake = `printf 't/a.test.ts:\\n${fails} 0 pass\\n ${names.length} fail\\n'; exit 1`;
  const checks = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
  try {
    const base = await commitToBranch(app, alice, repo, {
      message: "base",
      files: [
        { path: "forge.json", content: JSON.stringify({ check: { run: fake, install: "" } }) },
        { path: "t/a.test.ts", content: spec("expect(1).toBe(1);") },
      ],
    });
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    const topic = await commitToBranch(app, alice, repo, { branch: "topic", message: "topic", files: branchFiles });
    if (!topic.ok) throw new Error(JSON.stringify(topic.error));
    const pull = await openPull(app, alice, repo, { title: "t", body: "", baseBranch: "main", headBranch: "topic" });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    const oid = topic.value.commitOid;
    const deadline = Date.now() + 40_000;
    const finished = () => listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find((r) => r.commitOid === oid && (r.state === "ok" || r.state === "failed"));
    while (Date.now() < deadline && finished() === undefined) await Bun.sleep(100);
    if (finished() === undefined) throw new Error(`never came: still waiting while finished() === undefined`);
    const run = finished()!;
    return { oid, run, log: readRunLog(app.config.dataDir, run.id).lines.join("\n"), flakes: () => flakeList(app.db, Date.now()).filter((f) => f.repo === `alice/${name}`) };
  } finally {
    await checks.stop();
  }
}

test("an untouched test that fails and passes alone leaves the pull green and the flake recorded", async () => {
  const { run, log, flakes } = await pullCheck("untouched", ["grp > flaky"], [{ path: "notes.txt", content: "x" }]);
  expect(log).toContain("re-running 1 failed test(s) alone");
  expect(log).toContain("flake: t/a.test.ts > grp > flaky passed alone");
  expect(run.state).toBe("ok");
  // Main's push flaked too; the pull's flake counts with it toward FILE_AT.
  expect(flakes()[0]).toMatchObject({ test: "grp > flaky", file: "t/a.test.ts", count: 2 });
}, 60_000);

test("a test the pull changed is never re-run", async () => {
  const { oid, run, log, flakes } = await pullCheck("touched", ["grp > flaky"], [{ path: "t/a.test.ts", content: spec("expect(1).toBe(1); /* edit */") }]);
  expect(log).not.toContain("re-running");
  expect(log).toContain("not re-run alone");
  expect(run.state).toBe("failed");
  // Only main's own push recorded a flake; the pull's commit did not.
  expect(flakes().every((f) => f.lastCommit !== oid)).toBe(true);
}, 60_000);

test("a shaping file in the pull keeps the red", async () => {
  const { run, log } = await pullCheck("shaping", ["grp > flaky"], [{ path: "package.json", content: "{}" }]);
  expect(log).toContain("not re-run alone");
  expect(run.state).toBe("failed");
});

test("three failures are not re-run", async () => {
  const { run, log } = await pullCheck("three", ["a", "b", "c"], [{ path: "notes.txt", content: "x" }]);
  expect(log).not.toContain("re-running");
  expect(run.state).toBe("failed");
}, 60_000);

test("a flake issue says whether it flaked in a pull's check or main's", async () => {
  const made = await createRepo(app, alice, { name: "wording", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const t = [{ file: "t/a.test.ts", name: "grp > words" }];
  const body = () => app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE repo_id = ?1").all(made.value.id).map((i) => i.body).join("\n");
  recordFlakes(app.db, app.bus, made.value, t, { runId: "r1", commit: "aaaaaaa1", pull: true });
  recordFlakes(app.db, app.bus, made.value, t, { runId: "r2", commit: "bbbbbbb2", pull: true });
  expect(body()).toContain("in a pull's check");
  expect(body()).not.toContain("main's check");
  const other = [{ file: "t/b.test.ts", name: "grp > main" }];
  recordFlakes(app.db, app.bus, made.value, other, { runId: "r3", commit: "ccccccc3" });
  recordFlakes(app.db, app.bus, made.value, other, { runId: "r4", commit: "ddddddd4" });
  expect(body()).toContain("in main's check");
});
