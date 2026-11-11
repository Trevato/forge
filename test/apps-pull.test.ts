/**
 * An adapter's `/pull` answer is judged at the boundary and every pull leaves
 * a run of kind `pull` (#10042, docs/ADAPTERS.md): a failing answer is
 * recorded failed with its reason, a repeated cursor is recorded and writes
 * nothing twice, and out-of-range counts or a multi-line cursor are refused.
 * No network: answers are strings.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parsePullAnswer,
  PULL_BODY_MAX,
  recordPull,
  REPEAT_REASON,
  type PullAnswer,
} from "../src/apps/pull.ts";
import { lastPullCursor, listPullRuns } from "../src/core/runs.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { migrate } from "../src/kernel/migrate.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, migrationFiles);
});
afterEach(() => db.close());

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ pulled: 12, skipped: 3, cursor: "2026-11-09T07:00:00Z", errors: 0, ...over });

const reasonOf = (answer: PullAnswer): string => (answer.ok ? "" : answer.reason);

describe("parsePullAnswer", () => {
  test("a good answer gives its four fields", () => {
    expect(parsePullAnswer(200, body())).toEqual({
      ok: true,
      pulled: 12,
      skipped: 3,
      errors: 0,
      cursor: "2026-11-09T07:00:00Z",
    });
    // The edges of the range are inside it.
    expect(parsePullAnswer(204, body({ pulled: 0, skipped: 1_000_000 })).ok).toBe(true);
    expect(parsePullAnswer(200, body({ cursor: "x".repeat(200) })).ok).toBe(true);
  });

  test("out-of-range counts are refused, each naming its field", () => {
    expect(reasonOf(parsePullAnswer(200, body({ pulled: 1_000_001 })))).toBe(
      "pulled is not an integer from 0 to 1000000",
    );
    expect(reasonOf(parsePullAnswer(200, body({ skipped: -1 })))).toBe(
      "skipped is not an integer from 0 to 1000000",
    );
    expect(reasonOf(parsePullAnswer(200, body({ errors: 1.5 })))).toBe(
      "errors is not an integer from 0 to 1000000",
    );
    expect(parsePullAnswer(200, body({ pulled: "12" })).ok).toBe(false);
    expect(parsePullAnswer(200, '{"pulled":1e400,"skipped":0,"cursor":"a","errors":0}').ok).toBe(false);
  });

  test("a multi-line, over-long or unprintable cursor is refused", () => {
    const why = "cursor is not one line of at most 200 printable characters";
    expect(reasonOf(parsePullAnswer(200, body({ cursor: "page-1\npage-2" })))).toBe(why);
    expect(reasonOf(parsePullAnswer(200, body({ cursor: "a\rb" })))).toBe(why);
    expect(reasonOf(parsePullAnswer(200, body({ cursor: "a b" })))).toBe(why);
    expect(reasonOf(parsePullAnswer(200, body({ cursor: "a\u0000b" })))).toBe(why);
    expect(reasonOf(parsePullAnswer(200, body({ cursor: "x".repeat(201) })))).toBe(why);
    expect(reasonOf(parsePullAnswer(200, body({ cursor: 7 })))).toBe(why);
  });

  test("a non-2xx status, an oversized body or a wrong shape is a failed pull with a reason", () => {
    expect(reasonOf(parsePullAnswer(500, body()))).toBe("status 500 is not 2xx");
    expect(reasonOf(parsePullAnswer(301, body()))).toBe("status 301 is not 2xx");
    const huge = body({ cursor: "c" }).replace("}", `,"pad":"${"x".repeat(PULL_BODY_MAX)}"}`);
    expect(reasonOf(parsePullAnswer(200, huge))).toBe("body is over 65536 bytes");
    expect(reasonOf(parsePullAnswer(200, "<html>"))).toBe("body is not JSON");
    expect(reasonOf(parsePullAnswer(200, "[1,2]"))).toBe("body is not a JSON object");
    expect(reasonOf(parsePullAnswer(200, "null"))).toBe("body is not a JSON object");
    expect(reasonOf(parsePullAnswer(200, body({ extra: 1 })))).toBe('unexpected field "extra"');
    expect(reasonOf(parsePullAnswer(200, '{"pulled":1,"skipped":0,"cursor":"a"}'))).toBe("errors is missing");
  });
});

describe("recordPull", () => {
  test("a failing answer is recorded as failed with its reason, and keeps the last good cursor", () => {
    recordPull(db, "app1", { ...parsePullAnswer(200, body({ cursor: "c1" })), durationMs: 40 });
    const run = recordPull(db, "app1", { ...parsePullAnswer(503, "busy"), durationMs: 12.6 });
    expect(run).toMatchObject({
      kind: "pull",
      appId: "app1",
      state: "failed",
      reason: "status 503 is not 2xx",
      written: 0,
      cursor: "",
      durationMs: 13,
      repeat: false,
    });
    expect(listPullRuns(db, "app1").map((r) => r.state)).toEqual(["failed", "ok"]);
    expect(lastPullCursor(db, "app1")).toBe("c1");
  });

  test("a repeated cursor is recorded and writes nothing twice", () => {
    const first = recordPull(db, "app1", { ...parsePullAnswer(200, body({ cursor: "c1" })), durationMs: 50 });
    expect(first).toMatchObject({ state: "ok", written: 12, skipped: 3, failed: 0, cursor: "c1", durationMs: 50, repeat: false });
    // The forge repeats the pull and the adapter answers the same cursor with the same counts.
    const again = recordPull(db, "app1", { ...parsePullAnswer(200, body({ cursor: "c1" })), durationMs: 30 });
    expect(again).toMatchObject({ state: "ok", written: 0, skipped: 15, cursor: "c1", repeat: true, reason: REPEAT_REASON });
    const runs = listPullRuns(db, "app1");
    expect(runs).toHaveLength(2);
    expect(runs.reduce((n, r) => n + r.written, 0)).toBe(12);
    // A failure between does not reset what counts as the last good cursor.
    recordPull(db, "app1", { ...parsePullAnswer(200, "oops"), durationMs: 1 });
    expect(recordPull(db, "app1", { ...parsePullAnswer(200, body({ cursor: "c1" })), durationMs: 1 }).repeat).toBe(true);
    // A new cursor writes again; another app's cursor is its own.
    expect(recordPull(db, "app1", { ...parsePullAnswer(200, body({ cursor: "c2", pulled: 4 })), durationMs: 1 }).written).toBe(4);
    expect(recordPull(db, "app2", { ...parsePullAnswer(200, body({ cursor: "c1" })), durationMs: 1 }).written).toBe(12);
  });

  test("a repeat's skipped stays inside the range", () => {
    recordPull(db, "a", { ...parsePullAnswer(200, body({ cursor: "c", pulled: 1_000_000, skipped: 1_000_000 })), durationMs: 0 });
    const again = recordPull(db, "a", { ...parsePullAnswer(200, body({ cursor: "c", pulled: 1_000_000, skipped: 1_000_000 })), durationMs: 0 });
    expect(again).toMatchObject({ written: 0, skipped: 1_000_000 });
  });

  test("an app's runs and its last good cursor are read from an index, never a scan or a sort", () => {
    // The plan of the SQL the readers really run, its parameters bound.
    const plan = (read: () => void): string => {
      const original = db.query.bind(db);
      const sqls: string[] = [];
      (db as unknown as { query: unknown }).query = (sql: string) => (sqls.push(sql), original(sql));
      try {
        read();
      } finally {
        (db as unknown as { query: unknown }).query = original;
      }
      return sqls
        .flatMap((sql) => {
          const n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
          return original(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: n }, () => "x"));
        })
        .map((r) => (r as { detail: string }).detail)
        .join("\n");
    };
    const last = plan(() => void lastPullCursor(db, "x"));
    expect(last).toContain("pull_run_app_ok");
    const list = plan(() => void listPullRuns(db, "x", 5));
    expect(list).toContain("pull_run_app");
    for (const p of [last, list]) {
      expect(p).not.toMatch(/^SCAN (?!.*USING (COVERING )?INDEX)/m);
      expect(p).not.toContain("TEMP B-TREE");
    }
  });
});
