/** The statement counter's waits do not hang when an earlier file left the wall clock frozen (#9299). */

import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { quiet, statements } from "./helpers/statements.ts";

afterEach(() => setSystemTime());

test("quiet and statements return on a frozen wall clock", async () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const db = new Database(":memory:");
  const t0 = performance.now();
  await quiet(db);
  const n = await statements(db, () => {
    db.query("select 1").get();
  });
  expect(n).toBe(1);
  expect(performance.now() - t0).toBeLessThan(2_000);
}, 10_000);
