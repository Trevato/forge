/**
 * A red main holds its pulls' checks (#1797): on in-memory SQLite, the
 * last finished check of the default branch decides, a person's ask is not
 * held, and the vitals carry one card naming the failing test.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { claimRun, createRun, finishRun, listActive, type Run } from "../src/core/runs.ts";
import { RED_HOLD_MS, heldChecks, laneSince, redHref, redMain, redSentence, sharedWithMain, unheld } from "../src/checks/red_main.ts";
import { coveredByRedFix } from "../src/crew/red_fix.ts";
import { budgetBreaches, findFaults } from "../src/crew/sentinel.ts";
import { redLines } from "../src/crew/notify.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { ErrorLedger } from "../src/kernel/log.ts";
import { RefusedLedger } from "../src/kernel/internal_refused.ts";

const OID = (c: string) => c.repeat(40);
const HOLD = RED_HOLD_MS;

let db: Database;
let pull: string;
beforeEach(() => {
  db = openDb(":memory:", migrations);
  db.run(
    "INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'trevato', 't@x', '')",
  );
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'forge')");
  db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i1', 'r1', 7, 'pull', 'p', 'u1')",
  );
  pull = "i1";
});

const main = (commit: string, state: "ok" | "failed", names: string[] = []): Run => {
  const run = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: OID(commit), reason: "push" });
  claimRun(db, run.id);
  return finishRun(db, run.id, {
    state,
    summary: state === "ok" ? "check passed in 9s" : "check failed: 1 test failed",
    ...(state === "failed" ? { checkDetail: { passed: 10, failed: names.length, names } } : {}),
  })!;
};
const pullCheck = (commit: string, reason = "push"): Run =>
  createRun(db, { repoId: "r1", kind: "check", env: "pull-7", issueId: pull, commitOid: OID(commit), reason });
const queued = () => listActive(db, "check").filter((r) => r.state === "queued");
const red = (id: string) => redMain(db, id);

describe("red main", () => {
  test("no check of main yet, or a green one, holds nothing", () => {
    pullCheck("a");
    expect(redMain(db, "r1")).toBeUndefined();
    main("b", "ok");
    expect(unheld(queued(), red, HOLD)).toHaveLength(1);
  });

  test("a failed main holds a pull's pushed check, names the test, and lets main's own check run", () => {
    main("b", "failed", ["acting on many asks at once"]);
    const held = pullCheck("a");
    const own = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: OID("c"), reason: "push" });
    const r = redMain(db, "r1")!;
    expect(r).toMatchObject({ repo: "trevato/forge", commitOid: OID("b"), failing: ["acting on many asks at once"] });
    expect(unheld(queued(), red, HOLD).map((x) => x.id)).toEqual([own.id]);
    expect(unheld(queued(), red, HOLD).map((x) => x.id)).not.toContain(held.id);
  });

  test("a main stopped by its cell's limit or budget holds nothing, and a failed test still does", () => {
    const stop = (summary: string) => {
      const run = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: OID("b"), reason: "push" });
      claimRun(db, run.id);
      finishRun(db, run.id, { state: "failed", summary });
    };
    const waiting = pullCheck("a");
    stop("check failed: stopped: used 4105 MiB of memory, over its 4096 MiB limit");
    expect(redMain(db, "r1")).toMatchObject({ limit: true, commitOid: OID("b") });
    expect(unheld(queued(), red, HOLD).map((x) => x.id)).toContain(waiting.id);
    expect(heldChecks(db)).toEqual([]);
    stop("budget: check took 31 min, limit 30");
    expect(unheld(queued(), red, HOLD).map((x) => x.id)).toContain(waiting.id);
    main("c", "failed", ["x"]);
    expect(redMain(db, "r1")!.limit).toBe(false);
    expect(unheld(queued(), red, HOLD).map((x) => x.id)).not.toContain(waiting.id);
  });

  test("a person's ask runs while main is red", () => {
    main("b", "failed", ["x"]);
    const asked = pullCheck("a", "asked");
    expect(unheld(queued(), red, HOLD).map((x) => x.id)).toEqual([asked.id]);
  });

  test("the latest finished check decides: green after red releases", () => {
    main("b", "failed", ["x"]);
    pullCheck("a");
    expect(unheld(queued(), red, HOLD)).toHaveLength(0);
    main("c", "ok");
    expect(unheld(queued(), red, HOLD)).toHaveLength(1);
  });

  test("the hold is bounded: a check queued RED_HOLD_MS ago runs anyway, and 0 holds nothing", () => {
    main("b", "failed", ["x"]);
    const p = pullCheck("a");
    const at = Date.parse(p.createdAt);
    expect(unheld(queued(), red, HOLD, at + HOLD - 1)).toHaveLength(0);
    expect(unheld(queued(), red, HOLD, at + HOLD).map((x) => x.id)).toEqual([p.id]);
    expect(unheld(queued(), red, 0, at)).toHaveLength(1);
  });

  test("a failed pull check is not a red main", () => {
    const p = pullCheck("a");
    claimRun(db, p.id);
    finishRun(db, p.id, { state: "failed", summary: "check failed" });
    pullCheck("d");
    expect(redMain(db, "r1")).toBeUndefined();
  });

  test("the sentence names the first failing test and counts what waits", () => {
    main("b", "failed", ["one", "two"]);
    pullCheck("a");
    const [card] = heldChecks(db);
    expect(card!.held).toBe(1);
    expect(redSentence(card!.red, card!.held)).toBe(
      'trevato/forge: main is red at bbbbbbb — "one" and 1 more fail; 1 pull check wait for it to pass.',
    );
  });

  test("the vitals carry one card for it, linked to main's failed run", () => {
    const failed = main("b", "failed", ["acting on many asks at once"]);
    pullCheck("a");
    db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i2', 'r1', 8, 'pull', 'q', 'u1')");
    createRun(db, { repoId: "r1", kind: "check", env: "pull-8", issueId: "i2", commitOid: OID("e"), reason: "push" });
    const v = vitals({
      db,
      dataDir: tmpdir(),
      signals: { errors: new ErrorLedger(), refused: new RefusedLedger() },
    });
    const cards = v.degraded.filter((d) => d.cause.startsWith("red:"));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.sentence).toContain('"acting on many asks at once" fails; 2 pull checks wait');
    expect(cards[0]!.href).toBe(`/trevato/forge/runs/${failed.id}`);
  });
});

describe("a red main shares (#1971)", () => {
  const failed = (names: string[]): Run => {
    const run = createRun(db, { repoId: "r1", kind: "check", env: "pull-7", issueId: pull, commitOid: OID("a"), reason: "push" });
    claimRun(db, run.id);
    return finishRun(db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 1, failed: names.length, names } })!;
  };

  test("a pull red on main's test only is main's; one more test is its own", () => {
    main("b", "failed", ["X"]);
    expect(sharedWithMain(redMain(db, "r1"), failed(["X"]))).toBe(true);
    expect(sharedWithMain(redMain(db, "r1"), failed(["X", "Y"]))).toBe(false);
    expect(sharedWithMain(redMain(db, "r1"), failed(["Y"]))).toBe(false);
  });

  test("nothing named, or a green main, shares nothing", () => {
    main("b", "failed", ["X"]);
    expect(sharedWithMain(redMain(db, "r1"), failed([]))).toBe(false);
    main("c", "ok");
    expect(sharedWithMain(redMain(db, "r1"), failed(["X"]))).toBe(false);
  });
});

describe("one fix issue for a red main (#1971)", () => {
  const dup = { id: "i9", title: 'Fix "a panel keeps its chart" on main', body: "" };
  const fixRow = () =>
    db.run(
      "INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES ('degraded:red-r1', 'i1', '', 'x', 'x')",
    );

  test("a red main's held checks are a breach: one finding, urgent, keyed by the repository", () => {
    db.run(
      "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES ('red:r1', 'trevato/forge: main is red — \"a panel keeps its chart\" fails', '/x', 1000)",
    );
    const found = budgetBreaches(db, 2000);
    expect(found.map((f) => f.key)).toEqual(["degraded:red-r1"]);
    expect(found[0]!.urgent).toBe(true);
    expect(found[0]!.fix).toContain("only issue");
  });

  test("while the fix issue is open, an issue quoting main's failing test is covered; not otherwise", () => {
    main("b", "failed", ["a panel keeps its chart"]);
    // No fix issue filed yet: nothing is covered.
    expect(coveredByRedFix(db, "r1", dup)).toBe(false);
    fixRow();
    expect(coveredByRedFix(db, "r1", dup)).toBe(true);
    // The fix issue itself, and an issue about another test, are handed out.
    expect(coveredByRedFix(db, "r1", { ...dup, id: "i1" })).toBe(false);
    expect(coveredByRedFix(db, "r1", { id: "i8", title: "Something else", body: "" })).toBe(false);
    // Once the fix issue closes, or main is green, nothing is held back.
    db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    expect(coveredByRedFix(db, "r1", dup)).toBe(false);
    db.run("UPDATE issue SET state = 'open' WHERE id = 'i1'");
    main("c", "ok");
    expect(coveredByRedFix(db, "r1", dup)).toBe(false);
  });
});

describe("the lane sentence and a red main", () => {
  const old = (ids: string[]) =>
    ids.forEach((id) =>
      db.run("UPDATE run SET created_at = ?2 WHERE id = ?1", [id, new Date(Date.now() - 20 * 60_000).toISOString()]),
    );
  const read = () =>
    vitals({
      db,
      signals: { errors: new ErrorLedger(), refused: new RefusedLedger() } as never,
      dataDir: tmpdir(),
      disk: () => ({ freeBytes: 95, totalBytes: 100 }),
    }).degraded;

  test("checks all held by a red main, with an idle lane, raise red: and not queue:check", () => {
    main("b", "failed", ["x"]);
    old(Array.from({ length: 10 }, (_, i) => pullCheck(String(i)).id));
    const causes = read().map((d) => d.cause);
    expect(causes).toContain("red:r1");
    expect(causes).not.toContain("queue:check");
  });

  test("some held, some free: the sentence counts the free ones and names the held", () => {
    main("b", "failed", ["x"]);
    const held = [pullCheck("1"), pullCheck("2"), pullCheck("3")];
    const asked = pullCheck("4", "asked");
    old([...held, asked].map((r) => r.id));
    const lane = read().find((d) => d.cause === "queue:check");
    expect(lane?.sentence).toStartWith("1 check waits behind one lane;");
    expect(lane?.sentence).toEndWith("; 3 more held by a red main.");
  });

  test("old held checks and a fresh free one: the lane is not blamed", () => {
    main("b", "failed", ["x"]);
    old([pullCheck("1"), pullCheck("2"), pullCheck("3")].map((r) => r.id));
    createRun(db, { repoId: "r1", kind: "check", env: "pull-7", issueId: pull, commitOid: OID("4"), reason: "asked" });
    const causes = read().map((d) => d.cause);
    expect(causes).toContain("red:r1");
    expect(causes).not.toContain("queue:check");
  });

  // #3946: main went green at 01:52, freeing 14 checks it had held since 01:38;
  // the lane started them that second and was blamed for their twenty minutes.
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const at = (run: Run, column: "created_at" | "finished_at", min: number) =>
    db.run(`UPDATE run SET ${column} = ?2 WHERE id = ?1`, [run.id, ago(min)]);

  test("checks a red main held, freed by the green a moment ago: the lane is not blamed", () => {
    at(main("b", "failed", ["x"]), "finished_at", 18);
    const held = [pullCheck("1"), pullCheck("2"), pullCheck("3")];
    held.forEach((r) => at(r, "created_at", 15));
    main("c", "ok");
    expect(read().map((d) => d.cause)).not.toContain("queue:check");
  });

  test("freed checks still waiting long after the green: the lane is a cause, since the green", () => {
    at(main("b", "failed", ["x"]), "finished_at", 40);
    const held = [pullCheck("1"), pullCheck("2")];
    held.forEach((r) => at(r, "created_at", 35));
    const green = main("c", "ok");
    at(green, "finished_at", 25);
    const lane = read().find((d) => d.cause === "queue:check");
    expect(lane?.since.slice(0, 16)).toBe(ago(25).slice(0, 16));
    expect(lane?.sentence).toStartWith(`2 checks wait behind one lane; the oldest since ${ago(25).slice(11, 16)};`);
  });

  test("a check held past the hold waits for the lane from the hold's end, not the green", () => {
    at(main("b", "failed", ["x"]), "finished_at", 60);
    at(pullCheck("1"), "created_at", 50);
    at(main("c", "ok"), "finished_at", 2);
    const lane = read().find((d) => d.cause === "queue:check");
    expect(lane?.sentence).toContain(`the oldest since ${ago(50 - HOLD / 60_000).slice(11, 16)};`);
  });

  test("an asked check, never held, keeps its whole wait after a red and a green", () => {
    at(main("b", "failed", ["x"]), "finished_at", 18);
    at(pullCheck("1", "asked"), "created_at", 15);
    main("c", "ok");
    expect(read().map((d) => d.cause)).toContain("queue:check");
  });

  test("a check queued after the green, or long before the red, keeps its queue time", () => {
    const release = { redAt: "2026-10-21T01:38:00.000Z", greenAt: "2026-10-21T01:52:00.000Z" };
    const check = (createdAt: string) => ({ issueId: pull, reason: "push", createdAt });
    expect(laneSince(check("2026-10-21T01:53:00.000Z"), release, HOLD)).toBe("2026-10-21T01:53:00.000Z");
    expect(laneSince(check("2026-10-21T01:00:00.000Z"), release, HOLD)).toBe("2026-10-21T01:00:00.000Z");
    expect(laneSince(check("2026-10-21T01:41:00.000Z"), release, HOLD)).toBe(release.greenAt);
    expect(laneSince({ ...check("2026-10-21T01:41:00.000Z"), issueId: null }, release, HOLD)).toBe(
      "2026-10-21T01:41:00.000Z",
    );
  });

  test("a main green twice, or red by a limit before its green, freed nothing: the wait counts whole", () => {
    at(main("b", "failed", ["x"]), "finished_at", 18);
    at(pullCheck("1"), "created_at", 15);
    main("c", "ok");
    expect(read().map((d) => d.cause)).not.toContain("queue:check");
    main("d", "ok");
    expect(read().map((d) => d.cause)).toContain("queue:check");
    const stopped = main("e", "failed");
    db.run("UPDATE run SET summary = 'check failed: budget: check took 61 min, limit 60' WHERE id = ?1", [stopped.id]);
    main("f", "ok");
    expect(read().map((d) => d.cause)).toContain("queue:check");
  });
});

describe("a red main in another repository (#3992)", () => {
  const span = (cause: string) =>
    db.run(
      "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 'x: main is red', '/x', 1000)",
      [cause],
    );

  test("files no sentinel issue for it; the forge's own red main still files one", () => {
    span("red:r2");
    span("red:r1");
    expect(budgetBreaches(db, 2000, "r1").map((f) => f.key)).toEqual(["degraded:red-r1"]);
    expect(findFaults(db, 2000, "r1").map((f) => f.key)).toEqual(["degraded:red-r1"]);
    expect(budgetBreaches(db, 2000, "r2").map((f) => f.key)).toEqual(["degraded:red-r2"]);
  });

  test("a manifest error reads as an invalid forge.json, quotes it and links to the file", () => {
    const run = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: OID("d"), reason: "push" });
    claimRun(db, run.id);
    finishRun(db, run.id, { state: "failed", summary: "check failed: forge.json: check.run is required" });
    const r = redMain(db, "r1")!;
    const sentence = redSentence(r, 2);
    expect(sentence).toContain("forge.json on main");
    expect(sentence).toContain("invalid");
    expect(sentence).toContain("forge.json: check.run is required");
    expect(redHref(r)).toBe("/trevato/forge/blob/main/forge.json");
    expect(redSentence(redMain(db, "r1")!, 0)).not.toContain("tests");
  });

  test("a failing test keeps its own sentence and run link", () => {
    const r = redMain(db, main("e", "failed", ["a test"]).repoId)!;
    expect(redSentence(r, 1)).toContain('"a test" fails');
    expect(redHref(r)).toBe(`/trevato/forge/runs/${r.runId}`);
  });

  test("the owner of the red repository is told, once per failing run", () => {
    main("f", "failed", ["a test"]);
    const lines = redLines({ db } as never, { id: "u1", kind: "user" } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.line).toContain("trevato/forge: main is red");
    expect(redLines({ db } as never, { id: "u2", kind: "user" } as never)).toEqual([]);
  });
});
