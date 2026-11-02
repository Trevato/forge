/**
 * A shared-red finding a builder can reproduce (#8286): it names the pulls
 * and check runs that failed the test, quotes the newest run's assertion
 * lines from the tail of its log, carries the base that run merged, and says
 * whether main's newest check passes. A private repository's pulls and log
 * lines never reach a finding filed elsewhere.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { claimRun, createRun, finishRun, setRunBase, type Run } from "../src/core/runs.ts";
import { assertionLines, sharedCause } from "../src/checks/shared_red.ts";
import { budgetBreaches, degradedCauses } from "../src/crew/sentinel.ts";
import { runLogPath } from "../src/runs/log.ts";

const TEST = "board > a card keeps its place";
let db: Database;
let dataDir: string;

beforeEach(() => {
  db = openDb(":memory:", migrations);
  dataDir = mkdtempSync(join(tmpdir(), "shared-evidence-"));
  mkdirSync(join(dataDir, "runs"));
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'trevato', 't@x', '')");
  db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r1', 'u1', 'forge', 'public')");
  for (const n of [41, 42, 43, 44, 45, 46])
    db.run(`INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i${n}', 'r1', ${n}, 'pull', 'p', 'u1')`);
});

const red = (issueId: string, base: string, log: string[]): Run => {
  const run = createRun(db, { repoId: "r1", kind: "check", env: `pull-${issueId}`, issueId, commitOid: "a".repeat(40), reason: "push" });
  claimRun(db, run.id);
  if (base !== "") setRunBase(db, run.id, base);
  writeFileSync(runLogPath(dataDir, run.id), log.join("\n") + "\n");
  return finishRun(db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 9, failed: 1, names: [TEST] } })!;
};

const logOf = (said: string): string[] => [
  "bun test v1.3.14",
  "test/board.test.ts:",
  "(pass) board > renders [1.00ms]",
  `error: expect(received).toBe(expected)`,
  `Expected: "${said}"`,
  `Received: "moved"`,
  "      at <anonymous> (test/board.test.ts:12:5)",
  `(fail) ${TEST} [3.00ms]`,
  "",
  " 9 pass",
  " 1 fail",
  "Ran 10 tests across 1 file. [1.00s]",
  "1 tests failed:",
  `(fail) ${TEST} [3.00ms]`,
];

function recordThree(): Run[] {
  return [
    red("i41", "b".repeat(40), logOf("first")),
    red("i42", "c".repeat(40), logOf("second")),
    red("i43", "d".repeat(40), logOf("third")),
  ];
}

const open = (now: number) =>
  db.run("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 's', '/x', ?2)", [
    sharedCause({ repoId: "r1", test: TEST }),
    now - 20 * 60_000,
  ]);

describe("a shared-red finding names its pulls and quotes the failure (#8286)", () => {
  test("three failed checks: the pulls, their runs newest first, the newest's lines and base", () => {
    const runs = recordThree();
    const now = Date.now();
    open(now);
    const [found] = budgetBreaches(db, now, "r1", dataDir);
    const ev = found!.evidence;
    expect(ev).toContain(`test: ${TEST}`);
    const failed = ev.filter((l) => l.startsWith("failed: "));
    expect(failed).toEqual([
      `failed: pull #43, check run ${runs[2]!.id}`,
      `failed: pull #42, check run ${runs[1]!.id}`,
      `failed: pull #41, check run ${runs[0]!.id}`,
    ]);
    expect(ev).toContain(`base: ${"d".repeat(40)} (run ${runs[2]!.id})`);
    expect(ev.filter((l) => l.startsWith("log: "))).toEqual([
      "log: error: expect(received).toBe(expected)",
      'log: Expected: "third"',
      'log: Received: "moved"',
      "log: at <anonymous> (test/board.test.ts:12:5)",
    ]);
    expect(ev).toContain("main: no check of main recorded");
    // The day's degraded finding for the same cause carries the same evidence.
    expect(degradedCauses(db, now, "r1", dataDir)[0]!.evidence.filter((l) => l.startsWith("failed: "))).toEqual(failed);
  });

  test("it says whether main's newest check passes the test", () => {
    recordThree();
    const main = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: "e".repeat(40), reason: "push" });
    claimRun(db, main.id);
    finishRun(db, main.id, { state: "ok", summary: "check passed" });
    const now = Date.now();
    open(now);
    expect(budgetBreaches(db, now, "r1", dataDir)[0]!.evidence).toContain(
      `main: passes on main's newest check, run ${main.id} at ${"e".repeat(40)}`,
    );
  });

  const mainCheck = (state: "ok" | "failed", names: string[] = []): Run => {
    const main = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: "e".repeat(40), reason: "push" });
    claimRun(db, main.id);
    return finishRun(db, main.id, {
      state,
      summary: state === "ok" ? "check passed" : "check failed",
      ...(state === "failed" ? { checkDetail: { passed: 9, failed: names.length, names } } : {}),
    })!;
  };

  test("main red on the same test reads as failing on main too", () => {
    recordThree();
    const main = mainCheck("failed", [TEST]);
    const now = Date.now();
    open(now);
    expect(budgetBreaches(db, now, "r1", dataDir)[0]!.evidence).toContain(
      `main: fails on main's newest check too, run ${main.id} at ${"e".repeat(40)}`,
    );
  });

  test("main red on another test still passes this one", () => {
    recordThree();
    const main = mainCheck("failed", ["some > other test"]);
    const now = Date.now();
    open(now);
    expect(budgetBreaches(db, now, "r1", dataDir)[0]!.evidence).toContain(
      `main: passes on main's newest check, run ${main.id} at ${"e".repeat(40)}`,
    );
  });

  test("six failed pulls: only the newest five are named", () => {
    const runs = [41, 42, 43, 44, 45, 46].map((n) => red(`i${n}`, "b".repeat(40), logOf(`${n}`)));
    const now = Date.now();
    open(now);
    const failed = budgetBreaches(db, now, "r1", dataDir)[0]!.evidence.filter((l) => l.startsWith("failed: "));
    expect(failed).toEqual(runs.slice(1).reverse().map((r, i) => `failed: pull #${46 - i}, check run ${r.id}`));
  });

  test("a run that merged no base says none was recorded", () => {
    recordThree();
    const last = red("i44", "", logOf("bare"));
    const now = Date.now();
    open(now);
    expect(budgetBreaches(db, now, "r1", dataDir)[0]!.evidence).toContain(`base: none recorded (run ${last.id})`);
  });

  test("a private repository's pulls and log lines stay out of a finding filed elsewhere", () => {
    db.run("UPDATE repo SET visibility = 'private' WHERE id = 'r1'");
    recordThree();
    const now = Date.now();
    open(now);
    const [elsewhere] = budgetBreaches(db, now, undefined, dataDir);
    expect(elsewhere!.evidence.some((l) => /^(failed|log|base|test): /.test(l))).toBe(false);
    // Filed in that same repository, its own readers see it.
    expect(budgetBreaches(db, now, "r1", dataDir)[0]!.evidence.some((l) => l.startsWith("failed: "))).toBe(true);
  });

  test("the quote stops at twenty lines and skips bun's recap", () => {
    const long = ["x.test.ts:", ...Array.from({ length: 30 }, (_, i) => `line ${i}`), `(fail) ${TEST}`, " 0 pass", " 1 fail", "1 tests failed:", `(fail) ${TEST}`];
    const quoted = assertionLines(long, TEST);
    expect(quoted).toHaveLength(20);
    expect(quoted.at(-1)).toBe("line 29");
    expect(assertionLines(["1 tests failed:", `(fail) ${TEST}`], TEST)).toEqual([]);
  });
});
