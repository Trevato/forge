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
import { RED_HOLD_MS, heldChecks, redMain, redSentence, unheld } from "../src/checks/red_main.ts";
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
