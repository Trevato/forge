import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getLook, recordLook } from "../src/core/looks.ts";
import { migrationFiles } from "../src/core/schema.ts";

const SIZE = { scrollWidth: 390, scrollHeight: 2000, innerWidth: 390, innerHeight: 844 };
const base = { appId: "a", env: "main", commitOid: "c1", kind: "phone" as const, path: "p.png" };

const fresh = (upTo?: string): Database => {
  const db = new Database(":memory:");
  for (const m of migrationFiles) {
    if (upTo !== undefined && m.name >= upTo) break;
    db.exec(m.sql);
  }
  return db;
};

test("a look keeps the size it was recorded with", () => {
  const db = fresh();
  recordLook(db, { ...base, size: SIZE });
  expect(getLook(db, "a", "main", "c1", "/", "phone", "light")?.size).toEqual(SIZE);
});

test("a look without a size stores nulls and reads back with no size", () => {
  const db = fresh();
  const look = recordLook(db, base);
  expect(look.size).toBeUndefined();
  expect("size" in look).toBe(false);
});

test("a retake without a size clears the old one", () => {
  const db = fresh();
  recordLook(db, { ...base, size: SIZE });
  expect(recordLook(db, base).size).toBeUndefined();
});

test("a row from before the migration reads with no size", () => {
  const db = fresh("20261109180000");
  db.run(
    `INSERT INTO look (id, app_id, env, commit_oid, page, kind, path) VALUES ('x','a','main','c1','/','phone','p.png')`,
  );
  db.exec(migrationFiles.find((m) => m.name.startsWith("20261109180000"))!.sql);
  const look = getLook(db, "a", "main", "c1", "/", "phone", "light");
  expect(look?.path).toBe("p.png");
  expect(look?.size).toBeUndefined();
});

test("a row with only some columns set has no size", () => {
  const db = fresh();
  recordLook(db, base);
  db.run("UPDATE look SET scroll_width = 1");
  expect(getLook(db, "a", "main", "c1", "/", "phone", "light")?.size).toBeUndefined();
});
