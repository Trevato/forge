/**
 * `scripts/index-use.ts` (#12011): which index each prepared statement walks,
 * and which indexes nothing uses and nothing keeps. The migration that drops
 * the seven it found leaves a fresh database without them.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import {
  bytesHeld,
  collectInto,
  indexUse,
  plannedIndexes,
  readLog,
  seeded,
  sqlLiterals,
  triggerStatements,
  unusedIndexes,
} from "../scripts/index-use.ts";

describe("SQL in source", () => {
  test("string, template and joined literals that read as SQL, with holes for `${…}`", () => {
    const text = [
      'const a = db.query("SELECT id FROM run WHERE state = ?1");',
      "const b = db.query(`",
      "  -- the queued ones",
      "  SELECT id FROM run WHERE id IN (${marks.map(() => `?`).join(',')})`);",
      'const c = "SELECT x " +',
      '  "FROM t";',
      "const re = /it's \"not\" a string/;",
      'const d = "not sql at all";',
      'const e = "SELECTED";',
    ].join("\n");
    expect(sqlLiterals(text)).toEqual([
      "SELECT id FROM run WHERE state = ?1",
      "SELECT id FROM run WHERE id IN (\u0000)",
      "SELECT x FROM t",
    ]);
  });
});

function small(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, state TEXT, parent_id INTEGER REFERENCES parent(id));
    CREATE INDEX t_a ON t(a);
    CREATE INDEX t_b ON t(b);
    CREATE UNIQUE INDEX t_ab ON t(a, b);
    CREATE INDEX t_live ON t(a) WHERE state = 'live';
    CREATE INDEX t_parent ON t(parent_id, a);
    CREATE INDEX t_named ON t(state, b);
    CREATE TABLE log (id INTEGER PRIMARY KEY, b TEXT);
    CREATE TRIGGER t_log AFTER INSERT ON t BEGIN INSERT INTO log (b) SELECT b FROM t WHERE b = NEW.b; END;
  `);
  return db;
}

describe("index use", () => {
  test("each index lists the statements whose plan walks it", () => {
    const db = small();
    expect(plannedIndexes(db, "SELECT id FROM t WHERE b = ?1")).toEqual(["t_b"]);
    expect(plannedIndexes(db, "SELECT id FROM t WHERE id = ?1")).toEqual([]);
    expect(plannedIndexes(db, "SELECT id FROM \u0000 WHERE b = ?1")).toBeNull();
    const use = indexUse(db, ["SELECT id FROM t WHERE b = ?1", "SELECT nonsense FROM nowhere"], new Set());
    expect(use.indexes.find((r) => r.name === "t_b")!.usedBy).toEqual(["SELECT id FROM t WHERE b = ?1"]);
    expect(use.unplanned).toEqual(["SELECT nonsense FROM nowhere"]);
  });

  test("unique, partial, a foreign key's lookup and a name code says are kept; the rest unused", () => {
    const db = small();
    const use = indexUse(db, [], new Set(["t_named"]));
    const kept = Object.fromEntries(use.indexes.map((r) => [r.name, r.kept]));
    expect(kept).toEqual({
      t_a: [],
      t_ab: ["unique"],
      t_b: [],
      t_live: ["partial"],
      t_named: ["named in code"],
      t_parent: ["foreign key"],
    });
    expect(unusedIndexes(use).map((r) => r.name)).toEqual(["t_a", "t_b"]);
  });

  test("a trigger's statements are planned, NEW and OLD bound", () => {
    const db = small();
    const inside = triggerStatements(db);
    expect(inside).toEqual(["INSERT INTO log (b) SELECT b FROM t WHERE b = ?"]);
    const use = indexUse(db, inside, new Set());
    expect(unusedIndexes(use).map((r) => r.name)).toEqual(["t_a", "t_named"]);
  });

  test("a seeded copy counts the bytes an index holds", () => {
    const db = small();
    const copy = seeded(db, 2000);
    expect(copy.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(2000);
    expect(bytesHeld(copy, ["t_b"])).toBeGreaterThan(4096);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(0);
  });

  test("a test run's collector writes each statement once and the script reads them back", () => {
    const dir = mkdtempSync(join(tmpdir(), "index-use-"));
    try {
      const file = join(dir, "sql.log");
      const note = collectInto(file);
      note("SELECT 1 FROM t");
      note("SELECT 1 FROM t");
      note("PRAGMA foreign_keys = ON");
      note("UPDATE t SET a = 'x\ny'");
      expect(readLog(file)).toEqual(["SELECT 1 FROM t", "UPDATE t SET a = 'x\ny'"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a fresh forge database has none of the seven indexes nothing used", () => {
  const db = openDb(":memory:", migrations);
  const gone = ["flow_valve_turn_at", "gift_redeem_code", "note_shipped_pull", "session_seen", "storage_repo", "telemetry_read_at", "delivery_due"];
  const left = db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${gone.map((n) => `'${n}'`).join(", ")})`)
    .all();
  expect(left).toEqual([]);
  db.close();
});
