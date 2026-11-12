/**
 * The full suite as a scheduled report (#7780): a red verification files one
 * labelled issue per failing file, a rerun adds to it instead of filing
 * again, and the red holds nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { MAX_FAILURES, redDetail, reportGreen, reportRed, reportTitle, REPORT_LABEL } from "../src/checks/report.ts";
import { failedTests } from "../src/checks/flake.ts";
import { heldByRed, redMain } from "../src/checks/red_main.ts";
import { failedFiles, passedFiles, VERIFY_ENV } from "../src/checks/verify.ts";
import { createIssue, getLabel, listIssues, listComments, labelsFor, setIssueLabels } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, getRun, type Run } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";

/**
 * What `bun test` 1.3 prints for three files, two with a failure, the green
 * one printed last, then its closing summary repeating every failure (#9523).
 */
const BUN_LOG = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "test/a.test.ts:",
  "(pass) a > ok [0.20ms]",
  "1 | test(\"one\", () => expect(1).toBe(2));",
  "error: expect(received).toBe(expected)",
  "(fail) a > one [0.11ms]",
  "",
  "test/b.test.ts:",
  "(fail) b > two [0.06ms]",
  "(skip) b > later",
  "",
  "test/c.test.ts:",
  "(pass) c > fine [0.05ms]",
  "",
  "1 tests skipped:",
  "(skip) b > later",
  "",
  "",
  "2 tests failed:",
  "(fail) a > one [0.11ms]",
  "(fail) b > two [0.06ms]",
  "",
  " 2 pass",
  " 1 skip",
  " 2 fail",
  " 2 expect() calls",
  "Ran 5 tests across 3 files. [38.00ms]",
];

describe("failedTests", () => {
  test("bun's closing summary gives no failure to the last file printed", () => {
    expect(failedTests(BUN_LOG)).toEqual([
      { file: "test/a.test.ts", name: "a > one", ms: 0 },
      { file: "test/b.test.ts", name: "b > two", ms: 0 },
    ]);
    expect(failedFiles(BUN_LOG)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  test("a failure after the summary with no header of its own is dropped", () => {
    expect(failedTests(["test/a.test.ts:", "(pass) a", " 1 pass", "Ran 1 tests across 1 files.", "(fail) stray"])).toEqual([]);
  });

  test("a second report in the same log starts its files again", () => {
    const shards = [...BUN_LOG, "test/d.test.ts:", "(fail) d > three", "1 tests failed:", "(fail) d > three"];
    expect(failedTests(shards).map((t) => t.file)).toEqual(["test/a.test.ts", "test/b.test.ts", "test/d.test.ts"]);
  });


  test("pairs each failure with the file that printed it, once", () => {
    const lines = [
      "test/a.test.ts:",
      "(pass) ok",
      "(fail) a > one [3.00ms]",
      "(fail) a > one [3.00ms]",
      "test/b.test.ts:",
      "(fail) b > two",
    ];
    expect(failedTests(lines)).toEqual([
      { file: "test/a.test.ts", name: "a > one", ms: 3 },
      { file: "test/b.test.ts", name: "b > two" },
    ]);
  });
});

describe("passedFiles", () => {
  test("only a file printed whole with passes and no failure", () => {
    expect(passedFiles(BUN_LOG)).toEqual(["test/c.test.ts"]);
  });

  test("a file cut off before its block closed is not passed", () => {
    expect(passedFiles(["test/a.test.ts:", "(pass) a", "test/b.test.ts:", "(pass) b"])).toEqual(["test/a.test.ts"]);
  });

  test("a file that failed in one block and passed in another is not passed", () => {
    const lines = ["test/a.test.ts:", "(fail) a", " 0 pass", "test/a.test.ts:", "(pass) a", " 1 pass"];
    expect(passedFiles(lines)).toEqual([]);
  });

  test("a file with no passing test, or a path that climbs out, is not passed", () => {
    expect(passedFiles(["test/a.test.ts:", "(skip) a", "../x.test.ts:", "(pass) x", " 1 pass"])).toEqual([]);
  });
});

describe("the report", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-report-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    const made = await createRepo(app, created.value, { name: "app", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterEach(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const red = (env: string, commit: string): Run => {
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env, commitOid: commit, reason: "schedule" });
    const detail = {
      passed: 10,
      failed: 3,
      names: ["a > one", "a > two", "b > three"],
      files: ["test/a.test.ts", "test/b.test.ts"],
      failures: [
        { file: "test/a.test.ts", name: "a > one" },
        { file: "test/a.test.ts", name: "a > two" },
        { file: "test/b.test.ts", name: "b > three" },
      ],
    };
    app.db
      .query("UPDATE run SET state = 'failed', check_detail = ?2, finished_at = ?3 WHERE id = ?1")
      .run(run.id, JSON.stringify(detail), new Date().toISOString());
    return getRun(app.db, run.id)!;
  };

  const reports = () => listIssues(app.db, repo.id, { label: REPORT_LABEL, state: "all" });

  test("one labelled issue per failing file, naming its failing tests", () => {
    const lines = reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    expect(lines).toHaveLength(2);
    const issues = reports();
    expect(issues.map((i) => i.title).sort()).toEqual([
      reportTitle("test/a.test.ts"),
      reportTitle("test/b.test.ts"),
    ]);
    const a = issues.find((i) => i.title === reportTitle("test/a.test.ts"))!;
    expect(a.body).toContain("a > one");
    expect(a.body).toContain("a > two");
    expect(a.body).not.toContain("b > three");
    expect(a.body).toContain("Files: test/a.test.ts");
    expect(labelsFor(app.db, a.id).map((l) => l.name)).toEqual([REPORT_LABEL]);
  });

  test("a rerun files nothing new: it adds to the open issues", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    const again = reportRed(app, repo, red(VERIFY_ENV, "b".repeat(40)));
    expect(again.every((l) => l.startsWith("report: added to #"))).toBe(true);
    expect(reports()).toHaveLength(2);
    const a = reports().find((i) => i.title === reportTitle("test/a.test.ts"))!;
    expect(listComments(app.db, a.id)).toHaveLength(1);
  });

  test("a closed issue is filed anew when the file fails again", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1").run(repo.id);
    reportRed(app, repo, red(VERIFY_ENV, "b".repeat(40)));
    expect(reports()).toHaveLength(4);
  });

  test("a green verification files nothing", () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: VERIFY_ENV, commitOid: "c".repeat(40) });
    app.db.query("UPDATE run SET state = 'ok' WHERE id = ?1").run(run.id);
    expect(reportRed(app, repo, getRun(app.db, run.id)!)).toEqual([]);
    expect(reports()).toHaveLength(0);
  });

  test("a red report holds nothing: main is not red, and a pull's check is not held", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    const main = redMain(app.db, repo.id);
    expect(main).toBeUndefined();
    const check = { kind: "check" as const, issueId: "x", reason: "", createdAt: new Date().toISOString() };
    expect(heldByRed(check, main, 20 * 60_000, Date.now())).toBe(false);
  });

  test("a run carries at most forty failures, only under its failing files", () => {
    const lines = ["test/a.test.ts:", ...Array.from({ length: 60 }, (_, i) => `(fail) a > t${i}`), "test/c.test.ts:", "(fail) c > x"];
    const detail = redDetail(undefined, ["test/a.test.ts"], lines)!;
    expect(detail.failures).toHaveLength(MAX_FAILURES);
    expect(detail.failures!.every((f) => f.file === "test/a.test.ts")).toBe(true);
    expect(detail.files).toEqual(["test/a.test.ts"]);
    expect(redDetail(undefined, [], lines)).toBeUndefined();
  });

  test("a file whose own tests all passed is filed for nothing, though bun printed it last", () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: VERIFY_ENV, commitOid: "d".repeat(40) });
    const detail = redDetail(undefined, failedFiles(BUN_LOG), BUN_LOG)!;
    app.db
      .query("UPDATE run SET state = 'failed', check_detail = ?2 WHERE id = ?1")
      .run(run.id, JSON.stringify(detail));
    reportRed(app, repo, getRun(app.db, run.id)!);
    const issues = reports();
    expect(issues.map((i) => i.title).sort()).toEqual([reportTitle("test/a.test.ts"), reportTitle("test/b.test.ts")]);
    const b = issues.find((i) => i.title === reportTitle("test/b.test.ts"))!;
    expect(b.body).toContain("b > two");
    expect(b.body).not.toContain("a > one");
  });

  const green = (commit: string): Run => {
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: VERIFY_ENV, commitOid: commit, reason: "schedule" });
    app.db.query("UPDATE run SET state = 'ok', finished_at = ?2 WHERE id = ?1").run(run.id, new Date().toISOString());
    return getRun(app.db, run.id)!;
  };
  const issueFor = (file: string) => reports().find((i) => i.title === reportTitle(file))!;

  test("red, then a green run that passed the file closes its issue, then a run without the file leaves the other open (#9524)", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    const ok = green("e".repeat(40));
    expect(reportGreen(app, repo, ok, ["test/a.test.ts", "test/z.test.ts"])).toEqual([
      `report: closed #${issueFor("test/a.test.ts").number}, test/a.test.ts green again`,
    ]);
    const a = issueFor("test/a.test.ts");
    expect(a.state).toBe("closed");
    expect(a.closeReason).toBe("done");
    expect(listComments(app.db, a.id).map((c) => c.body)).toEqual([
      `Green again in the full suite (check run ${ok.id}, eeeeeee).`,
    ]);
    // b's shard never ran in that run: its issue stays open, and stays open again.
    expect(issueFor("test/b.test.ts").state).toBe("open");
    expect(reportGreen(app, repo, green("f".repeat(40)), ["test/c.test.ts"])).toEqual([]);
    expect(issueFor("test/b.test.ts").state).toBe("open");
    expect(listComments(app.db, issueFor("test/b.test.ts").id)).toHaveLength(0);
  });

  test("a red run closes the issue of a file it passed, and keeps the one it failed", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: VERIFY_ENV, commitOid: "d".repeat(40) });
    app.db.query("UPDATE run SET state = 'failed' WHERE id = ?1").run(run.id);
    expect(reportGreen(app, repo, getRun(app.db, run.id)!, ["test/b.test.ts"])).toHaveLength(1);
    expect(issueFor("test/a.test.ts").state).toBe("open");
    expect(issueFor("test/b.test.ts").state).toBe("closed");
  });

  test("an issue a person wrote, with the report's label and title, is never closed", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    const label = getLabel(app.db, repo.id, REPORT_LABEL)!;
    const made = createIssue(app.db, { repoId: repo.id, authorId: repo.ownerId, title: reportTitle("test/p.test.ts"), body: "I saw this fail." });
    if (!made.ok) throw new Error("issue");
    setIssueLabels(app.db, made.value.id, [label.id]);
    expect(reportGreen(app, repo, green("e".repeat(40)), ["test/p.test.ts"])).toEqual([]);
    expect(issueFor("test/p.test.ts").state).toBe("open");
  });

  test("a run that is still going closes nothing", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: VERIFY_ENV, commitOid: "e".repeat(40) });
    expect(reportGreen(app, repo, run, ["test/a.test.ts"])).toEqual([]);
    expect(issueFor("test/a.test.ts").state).toBe("open");
  });

  test("the issue says only what the run recorded", () => {
    reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
    expect(reports()[0]!.body).not.toContain("run alone");
  });

  test("the terminal's Flow dialog counts the open report issues", () => {
    process.env.FORGE_SENTINEL_REPO = "alice/app";
    try {
      expect(flowLines(app.db).join("\n")).toContain("Full suite report: 0 open issues");
      reportRed(app, repo, red(VERIFY_ENV, "a".repeat(40)));
      expect(flowLines(app.db).join("\n")).toContain("Full suite report: 2 open issues labelled full-suite");
    } finally {
      delete process.env.FORGE_SENTINEL_REPO;
    }
  });
});
