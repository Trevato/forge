/** Sentinel on #9548: the prepared-statement cap is set through a cast, so prove Bun took it. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { QUERY_CACHE, openDb } from "../src/kernel/db.ts";

test("a connection keeps far more than Bun's default 20 statements prepared, once each", () => {
  expect((Database as unknown as { MAX_QUERY_CACHE_SIZE: number }).MAX_QUERY_CACHE_SIZE).toBe(QUERY_CACHE);
  const db = openDb(":memory:", []);
  try {
    // Thirty is what one code page asks; 200 distinct texts is well past the default.
    const texts = Array.from({ length: 200 }, (_, i) => `SELECT ${i} AS n`);
    const first = texts.map((sql) => db.query(sql));
    const again = texts.map((sql) => db.query(sql));
    for (let i = 0; i < texts.length; i++) expect(again[i]).toBe(first[i]);
    expect((again[150]!.get() as { n: number }).n).toBe(150);
  } finally {
    db.close();
  }
});
