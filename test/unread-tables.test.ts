/**
 * A table a migration creates that no code under src/ reads is a record nobody
 * can reach (#11843; reviewers asked "make the record reachable" in #9975,
 * #10663, #10664, #11735). It fails here unless `scripts/unread-tables-allow.json`
 * lists it, and a listed table that is now read fails too, so the list only shrinks.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createdTables, unreadTables } from "../scripts/unread-tables.ts";
import allowed from "../scripts/unread-tables-allow.json";

const root = new URL("..", import.meta.url).pathname;
const found = unreadTables(root);

test("every table a migration creates is read by code under src/, or allowed", () => {
  const fresh = found.filter((t) => !allowed.includes(t));
  expect(
    fresh,
    `rule "make the record reachable": no src/ code reads table ${fresh.join(", ")} (no FROM/JOIN); show it on a page, a /system line or an MCP tool, or it is not done (docs/VISION.md)`,
  ).toEqual([]);
});

test("an allowed table that is now read leaves the list", () => {
  const stale = allowed.filter((t) => !found.includes(t));
  expect(stale, `now read or gone, remove from scripts/unread-tables-allow.json: ${stale.join(", ")}`).toEqual([]);
});

test("unreadTables() counts FROM and JOIN in src, not migrations or tests, and follows drops and renames", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "unread-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  try {
    put(
      "src/core/migrations/1.ts",
      "export default `CREATE TABLE read_me (a INT); CREATE TABLE joined (a INT); CREATE TABLE write_only (a INT);\n" +
        "CREATE TABLE gone (a INT); CREATE TABLE tmp_new (a INT); CREATE TABLE test_only (a INT);`;\n",
    );
    put("src/core/migrations/2.ts", "export default `DROP TABLE gone; ALTER TABLE tmp_new RENAME TO final_name;`;\n");
    put(
      "src/a.ts",
      'db.query("SELECT a FROM read_me JOIN joined ON 1");\ndb.query("INSERT INTO write_only (a) VALUES (1)");\n' +
        'db.query("SELECT 1 FROM final_name");\n',
    );
    put("src/a.test.ts", 'db.query("SELECT 1 FROM test_only");\n');
    expect(createdTables(dir)).toEqual(["final_name", "joined", "read_me", "test_only", "write_only"]);
    expect(unreadTables(dir)).toEqual(["test_only", "write_only"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
