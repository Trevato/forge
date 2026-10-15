/**
 * The degraded history: spans of each cause, on in-memory SQLite with a
 * fixed `now`, no server.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { record, spans } from "../src/kernel/degraded_history.ts";

const T = Date.parse("2026-10-15T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const disk = (sentence = "Disk is nearly full: 5% free.") => ({
  cause: "disk",
  sentence,
  href: "/settings/capacity",
});

let db: Database;
beforeEach(() => {
  db = openDb(":memory:", migrations);
});
const count = () =>
  db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM degraded_span").get()!.n;

describe("degraded history", () => {
  test("a cause that appears and goes leaves one closed span", () => {
    record(db, [disk()], T);
    record(db, [], T + 10 * MIN);
    const found = spans(db, T - DAY, T + HOUR);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      cause: "disk",
      openedAt: T,
      closedAt: T + 10 * MIN,
      ms: 10 * MIN,
    });
  });

  test("a cause still there an hour later is one open span, and record twice changes nothing", () => {
    record(db, [disk()], T);
    record(db, [disk()], T + HOUR);
    record(db, [disk()], T + HOUR);
    expect(count()).toBe(1);
    const [span] = spans(db, T, T + 2 * HOUR);
    expect(span!.closedAt).toBeNull();
    expect(span!.ms).toBe(2 * HOUR);
  });

  test("the sentence of an open span is the latest", () => {
    record(db, [disk()], T);
    record(db, [disk("Disk is nearly full: 3% free.")], T + MIN);
    expect(spans(db, T, T + HOUR)[0]!.sentence).toBe("Disk is nearly full: 3% free.");
  });

  test("a span closed 31 days ago is gone, one closed 29 days ago stays", () => {
    record(db, [disk(), { ...disk(), cause: "errors" }], T - 40 * DAY);
    record(db, [{ ...disk(), cause: "errors" }], T - 31 * DAY);
    record(db, [], T - 29 * DAY);
    record(db, [], T);
    const causes = spans(db, T - 60 * DAY, T).map((s) => s.cause);
    expect(causes).toEqual(["errors"]);
  });

  test("spans over a day finds a span that began the day before", () => {
    record(db, [disk()], T - 30 * HOUR);
    record(db, [], T - 20 * HOUR);
    record(db, [disk()], T - 2 * HOUR);
    const found = spans(db, T - DAY, T);
    expect(found.map((s) => s.openedAt)).toEqual([T - 30 * HOUR, T - 2 * HOUR]);
    expect(spans(db, T - 10 * HOUR, T - 5 * HOUR)).toEqual([]);
  });

  test("a cause that flaps within a minute extends its span", () => {
    record(db, [disk()], T);
    record(db, [], T + MIN);
    record(db, [disk()], T + MIN + 30_000);
    expect(count()).toBe(1);
    expect(spans(db, T, T + HOUR)[0]!.closedAt).toBeNull();
    record(db, [], T + 10 * MIN);
    record(db, [disk()], T + 12 * MIN);
    expect(count()).toBe(2);
  });

  test("a failing database is logged once and never thrown", () => {
    db.exec("DROP TABLE degraded_span");
    const lines: string[] = [];
    const log = { debug() {}, info() {}, error() {}, warn: (m: string) => void lines.push(m) };
    record(db, [disk()], T, log);
    record(db, [disk()], T, log);
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});
