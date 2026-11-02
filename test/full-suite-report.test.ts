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
import { MAX_FAILURES, redDetail, reportRed, reportTitle, REPORT_LABEL } from "../src/checks/report.ts";
import { failedTests } from "../src/checks/flake.ts";
import { heldByRed, redMain } from "../src/checks/red_main.ts";
import { VERIFY_ENV } from "../src/checks/verify.ts";
import { listIssues, listComments, labelsFor } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, getRun, type Run } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";

describe("failedTests", () => {
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
      { file: "test/a.test.ts", name: "a > one" },
      { file: "test/b.test.ts", name: "b > two" },
    ]);
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
