/**
 * Every migration a roll can meet is additive (#875): the old process keeps
 * serving on the database the new one migrates, so a migration newer than
 * the releases still in play never drops, renames or rebuilds what they
 * read, and never adds a NOT NULL column they would not fill.
 */
import { describe, expect, test } from "bun:test";
import releases from "../src/core/releases.json" with { type: "json" };
import { migrations } from "../src/core/schema.ts";
import { notAdditive } from "../src/kernel/migrate.ts";

describe("migrations are additive across a roll", () => {
  test("the guard names what an old process could not serve under", () => {
    expect(notAdditive("DROP TABLE run;")).toEqual(["drops a table"]);
    expect(notAdditive("ALTER TABLE run DROP COLUMN reason;")).toEqual([
      "drops a column",
    ]);
    expect(notAdditive("ALTER TABLE run RENAME TO runs;")).toEqual([
      "renames a table or a column",
    ]);
    expect(notAdditive("ALTER TABLE run RENAME COLUMN reason TO why;")).toEqual(
      ["renames a table or a column"],
    );
    expect(
      notAdditive("ALTER TABLE run ADD COLUMN why TEXT NOT NULL;"),
    ).toEqual(["adds a NOT NULL column without a default"]);
    // The spellings SQLite also accepts: COLUMN left out, a comment
    // between the words, a quoted name.
    expect(notAdditive("DROP /* c */ TABLE x;")).toEqual(["drops a table"]);
    expect(notAdditive("ALTER TABLE t RENAME a TO b;")).toEqual([
      "renames a table or a column",
    ]);
    expect(notAdditive("ALTER TABLE t ADD c INTEGER NOT NULL;")).toEqual([
      "adds a NOT NULL column without a default",
    ]);
    expect(notAdditive("ALTER TABLE t DROP c;")).toEqual(["drops a column"]);
    expect(notAdditive('ALTER TABLE "my table" DROP COLUMN c;')).toEqual([
      "drops a column",
    ]);
    // A quote inside a comment opens no string that could hide what follows.
    expect(notAdditive("-- don't\nDROP TABLE x;")).toEqual(["drops a table"]);
    // A table rebuild is a drop and a rename.
    expect(
      notAdditive(
        "CREATE TABLE run_next (id TEXT); INSERT INTO run_next SELECT id FROM run; DROP TABLE run; ALTER TABLE run_next RENAME TO run;",
      ),
    ).toEqual(["drops a table", "renames a table or a column"]);
  });

  test("what only adds passes, and words in quotes or comments are data", () => {
    for (const sql of [
      "CREATE TABLE IF NOT EXISTS x (id TEXT PRIMARY KEY);",
      "ALTER TABLE run ADD COLUMN why TEXT NOT NULL DEFAULT '';",
      "ALTER TABLE run ADD COLUMN why TEXT;",
      "CREATE INDEX IF NOT EXISTS x_id ON x(id); DROP INDEX IF EXISTS old_index;",
      "UPDATE run SET reason = 'drop table run' WHERE reason = '';",
      "-- DROP TABLE run is what we will not do\nINSERT INTO event (id) VALUES ('rename to');",
    ])
      expect(notAdditive(sql)).toEqual([]);
  });

  test("every migration newer than the releases still in play is additive", () => {
    const counts = releases.releases.slice(0, 2).map((r) => r.migrations);
    expect(counts.length).toBeGreaterThan(0);
    const floor = Math.min(...counts);
    expect(floor).toBeLessThanOrEqual(migrations.length);
    const offenders = migrations
      .map((sql, i) => ({ n: i + 1, problems: notAdditive(sql) }))
      .slice(floor)
      .filter((m) => m.problems.length > 0);
    expect(offenders).toEqual([]);
  });

  test("the release record is newest first and never ahead of the schema", () => {
    const counts = releases.releases.map((r) => r.migrations);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    for (const c of counts) expect(c).toBeLessThanOrEqual(migrations.length);
  });
});
