/**
 * A red many pulls share (#2266), on in-memory SQLite: a test failed by
 * three pulls in the hour is the lane's, one failed by fewer, or failed
 * longer ago, is the pull's own, and so is one main passes that no re-run
 * passed (#8786); the vitals carry one card per shared test,
 * linked to its flake issue once the sentinel has filed one.
 */
import { nameUnnamed } from "../src/checks/bun-test.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";
import { tally } from "../scripts/shards.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { claimRun, createRun, finishRun, type Run } from "../src/core/runs.ts";
import {
  SHARED_PULLS,
  SHARED_WINDOW_MS,
  TREE_GATES,
  flakeHref,
  flakeKey,
  pullsOwn,
  sharedCause,
  sharedTests,
  sharedWithPulls,
} from "../src/checks/shared_red.ts";
import { budgetBreaches, keyPart } from "../src/crew/sentinel.ts";
import { id, idFloor } from "../src/kernel/id.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { ErrorLedger } from "../src/kernel/log.ts";
import { RefusedLedger } from "../src/kernel/internal_refused.ts";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'trevato', 't@x', '')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'forge')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r2', 'u1', 'other')");
  for (let i = 1; i <= 6; i++)
    db.run(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i${i}', 'r1', ${i}, 'pull', 'p', 'u1')`,
    );
  db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('j1', 'r2', 1, 'pull', 'p', 'u1')");
});

const red = (issueId: string, names: string[], repoId = "r1"): Run => {
  const run = createRun(db, { repoId, kind: "check", env: `pull-${issueId}`, issueId, commitOid: "a".repeat(40), reason: "push" });
  claimRun(db, run.id);
  return finishRun(db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 1, failed: names.length, names } })!;
};
const shared = (run: Run | undefined, now?: number) => sharedWithPulls(db, run, now);
/** Main's newest check: green, or red naming `names`. */
const mainCheck = (state: "ok" | "failed", names: string[] = []): void => {
  const run = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: "b".repeat(40), reason: "push" });
  claimRun(db, run.id);
  finishRun(db, run.id, { state, summary: state, ...(state === "failed" ? { checkDetail: { passed: 1, failed: names.length, names } } : {}) });
};
/** A pull's re-run of the same commit, green. */
const green = (issueId: string): void => {
  const run = createRun(db, { repoId: "r1", kind: "check", env: `pull-${issueId}`, issueId, commitOid: "a".repeat(40), reason: "retry" });
  claimRun(db, run.id);
  finishRun(db, run.id, { state: "ok", summary: "ok" });
};

describe("a red many pulls share", () => {
  test("three pulls on one test share it; two do not", () => {
    red("i1", ["X"]);
    const second = red("i2", ["X"]);
    expect(shared(second)).toBe(false);
    const third = red("i3", ["X"]);
    expect(SHARED_PULLS).toBe(3);
    expect(shared(third)).toBe(true);
    expect(shared(second)).toBe(true);
  });

  test("bun's (unnamed) label is no test: unrelated pulls sharing it are not the lane's", () => {
    for (const i of ["i1", "i2", "i3"]) red(i, ["(unnamed)"]);
    expect(shared(red("i4", ["(unnamed)"]))).toBe(false);
    expect(sharedTests(db)).toEqual([]);
  });

  test("a named (unnamed) failure, with the error it threw, is no test either (#5727)", () => {
    const name = "a.test.ts > (unnamed): error: x";
    for (const i of ["i1", "i2", "i3"]) red(i, [name]);
    expect(shared(red("i4", [name]))).toBe(false);
    expect(sharedTests(db)).toEqual([]);
  });

  test("three pulls fail a test main passes, and none is a shared red (#8786)", () => {
    mainCheck("ok");
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const third = red("i3", ["X"]);
    expect(shared(third)).toBe(false);
    expect(sharedTests(db)).toEqual([]);
    expect(pullsOwn(db, "r1", "X", Date.now() - SHARED_WINDOW_MS)).toBe(true);
    const v = vitals({ db, dataDir: tmpdir(), signals: { errors: new ErrorLedger(), refused: new RefusedLedger() } });
    expect(v.degraded.filter((d) => d.cause.startsWith("shared:"))).toEqual([]);
    // Main red on other tests it named still ran this one, and passed it.
    mainCheck("failed", ["Y"]);
    expect(shared(red("i4", ["X"]))).toBe(false);
  });

  test("three pulls fail a test main also fails, and it is shared (#8786)", () => {
    mainCheck("failed", ["X"]);
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    expect(shared(red("i3", ["X"]))).toBe(true);
    expect(sharedTests(db).map((t) => t.test)).toEqual(["X"]);
  });

  test("a flake that passes on a pull's re-run is still the lane's, main green (#8786)", () => {
    mainCheck("ok");
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const third = red("i3", ["X"]);
    expect(shared(third)).toBe(false);
    // i2's re-run of the same commit is green: the test is random, not i2's.
    green("i2");
    expect(shared(third)).toBe(true);
    expect(sharedTests(db).map((t) => t.test)).toEqual(["X"]);
  });

  test("a re-run red on other tests it named passed this one; one naming nothing did not", () => {
    mainCheck("ok");
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const third = red("i3", ["X"]);
    red("i2", []);
    expect(shared(third)).toBe(false);
    const broken = red("i2", ["Y"]);
    db.run("UPDATE run SET check_detail = '{not json' WHERE id = ?1", [broken.id]);
    expect(shared(third)).toBe(false);
    red("i2", ["Y"]);
    expect(shared(third)).toBe(true);
  });

  test("a test the check runner re-ran alone and recorded a flake is the lane's (#8786)", () => {
    mainCheck("ok");
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const third = red("i3", ["X"]);
    expect(shared(third)).toBe(false);
    db.run(
      "INSERT INTO check_flake (id, repo_id, run_id, commit_oid, test, file, at) VALUES ('f1', 'r1', ?1, 'a', 'X', 'x.test.ts', ?2)",
      [third.id, new Date().toISOString()],
    );
    expect(shared(third)).toBe(true);
  });

  test("a test that fails again on the same pull's re-run, main green, is that pull's own", () => {
    mainCheck("ok");
    for (const i of ["i1", "i2", "i3"]) red(i, ["X"]);
    expect(shared(red("i3", ["X"]))).toBe(false);
    expect(sharedTests(db)).toEqual([]);
  });

  test("main's verdict unread (no check, or a red naming nothing) leaves a many-pull red the lane's", () => {
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const third = red("i3", ["X"]);
    expect(shared(third)).toBe(true);
    mainCheck("failed", []);
    expect(shared(third)).toBe(true);
  });

  test("every gate once listed by hand is each pull's own by the rule, main green (#2868, #7809, #8140, #7906, #8184)", () => {
    mainCheck("ok");
    const gates = [
      "design check: nothing added outside the system (#2678) > the tree is no worse than its baseline",
      "reserved names > every top-level page of the forge is a reserved name",
      "every registered /api/v1 route has an OpenAPI row or is listed as not yet described",
      "the gathered routes > the index is current: run `bun scripts/openapi-routes.ts`",
      "the gathered tools > the index is current: run `bun scripts/mcp-tools.ts`",
    ];
    for (const gate of gates) {
      for (const i of ["i1", "i2", "i3"]) red(i, [gate]);
      expect([gate, shared(red("i4", [gate]))]).toEqual([gate, false]);
      // Checked per gate: each gate's reds share one commit, so a later gate's red passes an earlier one, as a re-run would.
      expect(sharedTests(db).map((t) => t.test)).not.toContain(gate);
    }
  });

  test("every tree gate names a suite, or a test in it, that exists", () => {
    const names = new Set<string>();
    for (const f of new Glob("test/*.test.ts").scanSync(".")) for (const n of suiteNames(readFileSync(f, "utf8"))) names.add(n);
    for (const g of TREE_GATES) expect([g, names.has(g)]).toEqual([g, true]);
  });

  test("a gate naming a test under the wrong suite names nothing", () => {
    const names = suiteNames('describe("A", () => {\n  test("t", () => {});\n});\ndescribe("B", () => {\n  test("u", () => {});\n});\n');
    expect(names.has("A > t")).toBe(true);
    expect(names.has("B > u")).toBe(true);
    expect(names.has("B > t")).toBe(false);
    expect(names.has("A > u")).toBe(false);
    expect(suiteNames('test("top", () => {});\n').has("top")).toBe(true);
  });

  test("a top-level test is named bare; one inside a describe is not", () => {
    const names = suiteNames('test("t", () => {});\ndescribe("A", () => {\n  test("u", () => {});\n});\ntest("v", () => {});\n');
    expect(names.has("t")).toBe(true);
    expect(names.has("v")).toBe(true);
    expect(names.has("A > u")).toBe(true);
    expect(names.has("u")).toBe(false);
    expect(names.has("A > v")).toBe(false);
  });

  test("one pull red three times is its own red, not the lane's", () => {
    red("i1", ["X"]);
    red("i1", ["X"]);
    expect(shared(red("i1", ["X"]))).toBe(false);
  });

  test("every test the check names must be shared; naming none is the pull's own", () => {
    for (const i of ["i1", "i2", "i3"]) red(i, ["X"]);
    expect(shared(red("i4", ["X", "Y"]))).toBe(false);
    expect(shared(red("i5", ["Y"]))).toBe(false);
    expect(shared(red("i6", []))).toBe(false);
    expect(shared(undefined)).toBe(false);
  });

  test("another repository's reds, main's own, and reds older than the hour count for nothing", () => {
    red("j1", ["X"], "r2");
    const main = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: "b".repeat(40), reason: "push" });
    claimRun(db, main.id);
    finishRun(db, main.id, { state: "failed", summary: "check failed", checkDetail: { passed: 1, failed: 1, names: ["X"] } });
    red("i1", ["X"]);
    expect(shared(red("i2", ["X"]))).toBe(false);
    const third = red("i3", ["X"]);
    expect(shared(third)).toBe(true);
    expect(shared(third, Date.now() + SHARED_WINDOW_MS + 1_000)).toBe(false);
  });

  test("a check detail that is not JSON is skipped, not thrown on", () => {
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const broken = red("i3", ["X"]);
    db.run("UPDATE run SET check_detail = '{not json' WHERE id = ?1", [broken.id]);
    expect(shared(red("i4", ["X"]))).toBe(true);
    expect(sharedTests(db)[0]!.pulls).toBe(3);
  });

  test("the vitals carry one card per shared test, naming it, to file its flake issue", () => {
    for (const i of ["i1", "i2", "i3", "i4"]) red(i, ["X", "Y"]);
    red("i5", ["Z"]);
    const v = vitals({ db, dataDir: tmpdir(), signals: { errors: new ErrorLedger(), refused: new RefusedLedger() } });
    const cards = v.degraded.filter((d) => d.cause.startsWith("shared:"));
    expect(cards.map((c) => c.cause).sort()).toEqual(
      [sharedCause({ repoId: "r1", test: "X" }), sharedCause({ repoId: "r1", test: "Y" })].sort(),
    );
    expect(cards.find((c) => c.cause === sharedCause({ repoId: "r1", test: "X" }))!.sentence).toBe(
      `trevato/forge: "X" failed on 4 pulls in the last hour — the lane's red, not theirs; they wait for main's next green check, unparked.`,
    );
    expect(cards[0]!.href).toBe("/trevato/forge/issues/new");
  });

  test("once the sentinel files the flake issue, the card follows it; closed, it files again", () => {
    for (const i of ["i1", "i2", "i3"]) red(i, ["X"]);
    const [t] = sharedTests(db);
    db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('f1', 'r2', 9, 'issue', 'flake', 'u1')");
    db.run(
      "INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES (?1, 'f1', '', 'x', 'x')",
      [flakeKey(sharedCause(t!))],
    );
    expect(flakeHref(db, t!)).toBe("/trevato/other/issues/9");
    db.run("UPDATE issue SET state = 'closed' WHERE id = 'f1'");
    expect(flakeHref(db, t!)).toBe("/trevato/forge/issues/new");
  });

  test("the cause is the sentinel's key, whole, and a breach it files at once", () => {
    const cause = sharedCause({ repoId: "r1", test: "two forges in one process keep their own error and refusal signals" });
    expect(flakeKey(cause)).toBe(`degraded:${keyPart(cause)}`);
    expect(keyPart(cause)).toBe(cause.replaceAll(":", "-"));
    db.run("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 's', '/x', 1000)", [cause]);
    const [found] = budgetBreaches(db, 2000);
    expect(found!.key).toBe(flakeKey(cause));
    expect(found!.urgent).toBe(true);
  });

  test("an id made at or after a moment sorts at or above its floor", () => {
    const at = Date.now();
    expect(id(at) >= idFloor(at)).toBe(true);
    expect(idFloor(at - 1) < idFloor(at)).toBe(true);
    expect(idFloor(at)).toHaveLength(26);
  });
});

describe("a failure outside a named test names its file and hook (#4582)", () => {
  // Captured from bun 1.3.14 (`CI=1 bun test`): a beforeAll with a 50 ms
  // timeout, an afterAll that throws, then the summary and a headerless
  // recap such as bun prints when many tests fail.
  const captured = [
    "bun test v1.3.14 (0d9b296a)",
    "",
    "a.test.ts:",
    "(fail) (unnamed) [50.82ms]",
    "  ^ a beforeEach/afterEach hook timed out for this test.",
    "",
    "c.test.ts:",
    '1 | import { afterAll, describe, test } from "bun:test";',
    "error: late",
    "      at <anonymous> (c.test.ts:2:62)",
    "(fail) s > (unnamed) [0.13ms]",
    "",
    " 10 pass",
    " 2 fail",
    "Ran 12 tests across 2 files. [127.00ms]",
    "",
    "2 tests failed:",
    "(fail) (unnamed) [50.82ms]",
    "(fail) s > (unnamed) [0.13ms]",
  ];

  test("summary names the file and the hook, not (unnamed)", () => {
    const failure = summariseCheckFailure(captured, "check exited with code 1");
    // The (unnamed) fallout shows only when nothing else is named (#8730).
    expect(failure.detail?.names).toEqual(["a.test.ts > beforeEach/afterEach (timeout)"]);
    expect(failure.summary).toBe('2 of 12 tests — "a.test.ts > beforeEach/afterEach (timeout)" and 1 more');
  });

  test("the recap after the summary is not given the last file's name", () => {
    const named = nameUnnamed(captured);
    expect(named.slice(-2)).toEqual(captured.slice(-2));
  });

  test("the sharded tally echoes the named failure", () => {
    const { lines } = tally([{ files: ["a.test.ts"], code: 1, output: captured.join("\n") }], 1);
    expect(lines).toContain("(fail) a.test.ts > beforeEach/afterEach (timeout) [50.82ms] [shard 1]");
  });
});

const one = (body: string[]) => nameUnnamed(["a.test.ts:", ...body]).at(-1);

describe("a failure outside a test names what it threw (#5727)", () => {
  test("a thrown error is appended", () => {
    expect(
      one(["error: database is closed", "      at x (a.test.ts:1:1)", "(fail) (unnamed) [1.00ms]"]),
    ).toBe("(fail) a.test.ts > (unnamed): error: database is closed [1.00ms]");
  });

  test("a hook timeout is named as before", () => {
    const lines = nameUnnamed([
      "a.test.ts:",
      "error: late",
      "(fail) (unnamed) [50ms]",
      "  ^ a beforeAll hook timed out for this test.",
    ]);
    expect(lines[2]).toBe("(fail) a.test.ts > beforeAll (timeout) [50ms]");
  });

  test("no error line keeps today's name; an earlier test's error is not borrowed", () => {
    expect(one(["(fail) (unnamed) [1ms]"])).toBe("(fail) a.test.ts > (unnamed) [1ms]");
    expect(
      one(["error: other", "(fail) t [1ms]", "(fail) s > (unnamed) [1ms]"]),
    ).toBe("(fail) a.test.ts > s > (unnamed) [1ms]");
  });

  test("a long error is cut at 120, control characters and paths dropped", () => {
    const got = one([`error: ${"x".repeat(200)}`, "(fail) (unnamed)"])!;
    expect(got).toBe(`(fail) a.test.ts > (unnamed): error: ${"x".repeat(113)}`);
    expect(one(["error: bad\u001b /home/u/proj/f.ts", "(fail) (unnamed)"])).toBe(
      "(fail) a.test.ts > (unnamed): error: bad f.ts",
    );
  });
});

/** Each `describe > test` a test file declares, every test paired only with the describe it sits under, plus `describe > ` for each suite and each top-level test's bare name. */
function suiteNames(text: string): Set<string> {
  const names = new Set<string>();
  let suite: string | undefined;
  for (const m of text.matchAll(/^([ \t]*)(describe|test)\("((?:[^"\\]|\\.)*)"/gm)) {
    if (m[2] === "describe") names.add(`${(suite = m[3])} > `);
    else if (m[1] === "") names.add(m[3]!);
    else if (suite !== undefined) names.add(`${suite} > ${m[3]}`);
  }
  return names;
}
