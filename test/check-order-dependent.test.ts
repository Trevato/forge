import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { MAX_FILED, fileOrderDependent, orderDependent } from "../src/checks/order_dependent.ts";
import { createIssue, listComments, setIssueState } from "../src/core/issues.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const line = "fails only beside others: test/a.test.ts, test/b.test.ts (shard-mates: test/c.test.ts)";

test("the verdict line names each cleared file and its shard-mates", () => {
  expect(orderDependent(["noise", line])).toEqual([
    { file: "test/a.test.ts", mates: ["test/c.test.ts"] },
    { file: "test/b.test.ts", mates: ["test/c.test.ts"] },
  ]);
  expect(orderDependent(["fails only beside others: x.ts (shard-mates: none)"])[0]?.mates).toEqual([]);
  expect(orderDependent(["all green"])).toEqual([]);
  expect(orderDependent(["fails only beside others: $(rm) (shard-mates: none)"])).toEqual([]);
});

let dir: string;
let app: App;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "od-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a cleared file opens one issue, and its next appearance comments on it", async () => {
  const u = await createUser(app.db, { trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "r", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const repo = made.value;
  const found = orderDependent([line]);
  const ref = { runId: "run1", commit: "abcdef0123" };
  expect(fileOrderDependent(app.db, app.bus, repo, found, ref).length).toBe(2);
  expect(fileOrderDependent(app.db, app.bus, repo, found, { ...ref, runId: "run2" }).length).toBe(2);
  const list = app.db.query("SELECT id, title, body FROM issue WHERE repo_id = ?1 ORDER BY number").all(repo.id);
  expect(list.length).toBe(2);
  const first = list[0] as { id: string; title: string; body: string };
  expect(first.title).toContain("fails only beside others");
  expect(first.body).toContain("test/c.test.ts");
  expect(listComments(app.db, first.id).length).toBe(1);
});

test("one printed line cannot file more than the cap", () => {
  const many = Array.from({ length: 300 }, (_, i) => `t/f${i}.test.ts`).join(", ");
  const found = orderDependent([`fails only beside others: ${many} (shard-mates: none)`]);
  expect(found.length).toBe(MAX_FILED);
  const lines = Array.from({ length: 40 }, (_, i) => `fails only beside others: g${i}.ts (shard-mates: none)`);
  expect(orderDependent(lines).length).toBe(MAX_FILED);
});

test("a check run whose output has the verdict line files the issue; a closed one is not commented on", async () => {
  process.env["FORGE_CELLS"] = "off";
  const checks: ChecksHandle = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
  try {
    const u = { value: getUserByName(app.db, "alice")! };
    const made = await createRepo(app, u.value, { name: "wired", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const file = "t/closed.test.ts";
    // An earlier, closed issue for the file.
    const old = createIssue(app.db, { repoId: repo.id, authorId: u.value.id, title: `Test fails only beside others: ${file}` });
    if (!old.ok) throw new Error(old.error);
    setIssueState(app.db, old.value.id, "closed");
    const pushed = await commitToBranch(app, u.value, repo, {
      message: "check with a verdict line",
      files: [{
        path: "forge.json",
        content: JSON.stringify({ check: { run: `echo 'fails only beside others: ${file}, t/w.test.ts (shard-mates: t/m.test.ts)'`, install: "" } }),
      }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const oid = pushed.value.commitOid;
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      !listRuns(app.db, repo.id, { kind: "check", limit: 50 }).some((r) => r.commitOid === oid && r.state === "ok")
    ) await Bun.sleep(100);
    const rows = app.db
      .query<{ id: string; title: string; state: string; body: string }, [string]>(
        "SELECT id, title, state, body FROM issue WHERE repo_id = ?1 ORDER BY number")
      .all(repo.id);
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      [`Test fails only beside others: ${file}`, "closed"],
      [`Test fails only beside others: ${file}`, "open"],
      ["Test fails only beside others: t/w.test.ts", "open"],
    ]);
    expect(rows[1]!.body).toContain("t/m.test.ts");
    expect(listComments(app.db, rows[0]!.id).length).toBe(0);
  } finally {
    await checks.stop();
  }
});

test("a branch's check log files nothing; the default branch's files at most the cap and says what it left", async () => {
  process.env["FORGE_CELLS"] = "off";
  const checks: ChecksHandle = startChecks(app, { forgeUrl: "http://forge.test", concurrency: 1 });
  try {
    const u = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, u, { name: "gated", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const files = Array.from({ length: MAX_FILED + 2 }, (_, i) => `t/g${i}.test.ts`).join(", ");
    const manifest = JSON.stringify({
      check: { run: `echo 'fails only beside others: ${files} (shard-mates: none)'`, install: "" },
    });
    const waitOk = async (oid: string) => {
      const deadline = Date.now() + 30_000;
      while (
        Date.now() < deadline &&
        !listRuns(app.db, repo.id, { kind: "check", limit: 50 }).some((r) => r.commitOid === oid && r.state === "ok")
      ) await Bun.sleep(100);
    };
    const count = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue'").get(repo.id)!.n;
    const seed = await commitToBranch(app, u, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] });
    if (!seed.ok) throw new Error(JSON.stringify(seed.error));
    const branch = await commitToBranch(app, u, repo, {
      branch: "feature", message: "branch verdict", files: [{ path: "forge.json", content: manifest }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const pull = await openPull(app, u, repo, { title: "Verdict", baseBranch: "main", headBranch: "feature" });
    if (!pull.ok) throw new Error(String(pull.error));
    const pullRuns = () => listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter((r) => r.issueId !== null);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !pullRuns().some((r) => r.state === "ok")) await Bun.sleep(100);
    expect(pullRuns().some((r) => r.state === "ok")).toBe(true);
    expect(count()).toBe(0);
    const main = await commitToBranch(app, u, repo, {
      message: "main verdict", files: [{ path: "forge.json", content: manifest.replace("echo", "echo main;echo") }],
    });
    if (!main.ok) throw new Error(JSON.stringify(main.error));
    await waitOk(main.value.commitOid);
    expect(count()).toBe(MAX_FILED);
    const body = app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE repo_id = ?1 AND kind = 'issue' LIMIT 1").get(repo.id)!.body;
    expect(body).toContain("Filed by the check runner");
    const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find((r) => r.commitOid === main.value.commitOid)!;
    expect(readRunLog(app.config.dataDir, run.id).lines.join("\n")).toContain("not filed: 2 more (at most 5 per run)");
  } finally {
    await checks.stop();
  }
}, 40_000);
