import { expect, test } from "bun:test";
import { openDb, QUERY_CACHE } from "../src/kernel/db.ts";
import { migrations } from "../src/core/schema.ts";

// #9514: Bun keeps only 20 prepared statements a connection by default; a code
// page asks about thirty, so the rest were prepared again on every request.
test("a connection keeps far more than Bun's default 20 statements prepared", () => {
  const db = openDb(":memory:", migrations);
  try {
    const sql = (i: number) => `SELECT ${i} AS n`;
    for (let i = 0; i < 200; i++) db.query(sql(i)).get();
    // The same text answers with the same prepared statement: it was kept, not prepared again.
    expect(db.query(sql(150))).toBe(db.query(sql(150)));
    expect(db.query(sql(199))).toBe(db.query(sql(199)));
    expect(QUERY_CACHE).toBeGreaterThanOrEqual(1024);
  } finally {
    db.close();
  }
});
