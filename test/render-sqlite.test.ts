/** A committed SQLite file as its tables and first rows, read-only. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { renderBlob, capped } from "../src/web/pages/repo.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";
import { ROW_LIMIT, TABLE_CAP, hasTable, sqlite } from "../src/web/render/sqlite.ts";
import { expectWork } from "./helpers/work.ts";
import type { RepoScope } from "../src/web/scope.ts";

const make = (): Uint8Array => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, pic BLOB)");
  db.run("INSERT INTO notes (body, pic) VALUES ('<script>alert(1)</script>', x'00010203')");
  db.run("INSERT INTO notes (body, pic) VALUES (NULL, NULL)");
  db.run('CREATE TABLE "we""ird" (n INTEGER)');
  for (let i = 0; i < 250; i++) db.run('INSERT INTO "we""ird" VALUES (?)', [i]);
  db.run("CREATE VIEW recent AS SELECT id, body FROM notes");
  const bytes = db.serialize();
  db.close();
  return bytes;
};
const DB = make();
const draw = (body: Uint8Array, table?: string) =>
  sqlite({ path: "a.db", size: body.length, body, media: "/m", download: "/d", pathHref: "/o/r/blob/main/a.db", ...(table ? { table } : {}) });

describe("sqlite kind", () => {
  test("the header confirms it; a .db without it is binary", () => {
    expect(fileKind("a.db", DB.subarray(0, 4096))).toBe("sqlite");
    expect(fileKind("a.sqlite3", DB.subarray(0, 4096))).toBe("sqlite");
    expect(fileKind("a.db", new Uint8Array([1, 0, 2, 3]))).toBe("binary");
    expect(RENDERERS.sqlite).toBe(sqlite);
  });
});

describe("sqlite page", () => {
  test("lists tables and views with counts and columns", () => {
    const r = draw(DB);
    const h = String(r.content);
    expect(r.fallback).toBeUndefined();
    expect(r.summary).toContain("2 tables · 1 view"); expect(r.summary).not.toContain("1 views");
    expect(h).toContain('href="/o/r/blob/main/a.db?table=notes"');
    expect(h).toContain("2 rows");
    expect(h).toContain("250 rows");
    expect(h).toContain("id, body, pic");
    expect(h).toContain("recent");
  });
  test("?table shows rows: escaped, BLOB as size, NULL, capped at 100", () => {
    const h = String(draw(DB, "notes").content);
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(h).not.toContain("<script>");
    expect(h).toContain("BLOB · 4 B");
    expect(h).toContain("NULL");
    const big = String(draw(DB, 'we"ird').content);
    expect(big.split("<tr>").length - 1).toBe(ROW_LIMIT + 1);
    expect(String(draw(DB, "recent").content)).toContain("<th>body</th>");
  });
  test("an unknown table, or an injection attempt, goes back to the list", () => {
    for (const t of ["nope", 'notes"; DROP TABLE notes; --', "sqlite_master"]) {
      const h = String(draw(DB, t).content);
      expect(h).toContain("has no table named");
      expect(h).toContain("?table=notes");
      expect(h).not.toContain("<th>pic</th>");
    }
  });
  test("a truncated or corrupt file falls back with one sentence", () => {
    expect(draw(DB.slice(0, 5000)).fallback).toBeDefined();
    const junk = new Uint8Array(DB.length).fill(7);
    junk.set(DB.subarray(0, 16));
    expect(draw(junk).fallback).toBeDefined();
  });
});

describe("sqlite on the blob page", () => {
  const scope = { base: "/o/r", facts: { name: "r" }, caps: { write: false }, kind: "local" } as unknown as RepoScope;
  const page = (name: string, body: Uint8Array, table?: string) =>
    String(
      renderBlob(scope, {
        refs: { branches: ["main"], tags: [] },
        ref: "main",
        path: name,
        blob: capped({ kind: "binary", body, size: body.length }, name),
        ...(table ? { table } : {}),
      }),
    );
  test("rendered, with the table", () => {
    expect(page("a.db", DB)).toContain("Tables and views");
    expect(page("a.db", DB, "notes")).toContain("&lt;script&gt;");
  });
  test("a non-SQLite .db stays binary; a corrupt one offers Download", () => {
    expect(page("a.db", new Uint8Array([1, 0, 2]))).toContain("Binary file");
    const h = page("a.db", DB.slice(0, 5000));
    expect(h).toContain("Showing the source: This SQLite file is cut short or damaged");
    expect(h).toContain("Download");
  });
  test("a file over the 1 MB page ceiling but under the sqlite cap is drawn, not binary", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE big (v TEXT)");
    db.run("INSERT INTO big SELECT hex(randomblob(500)) FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 3000) SELECT n FROM c)");
    const body = db.serialize();
    db.close();
    expect(body.length).toBeGreaterThan(1_000_000);
    const h = page("big.db", body);
    expect(h).toContain("Tables and views");
    expect(h).toContain("3,000 rows");
    expect(page("big.db", body, "big")).toContain("<th>v</th>");
  });
  test("a file over the 5 MB sqlite cap offers Download instead", () => {
    const body = new Uint8Array(5_500_000);
    body.set(DB);
    const h = page("huge.db", body);
    expect(h).not.toContain("Tables and views");
    expect(h).toContain("Download");
  });
});

describe("sqlite details", () => {
  test("hasTable names only tables and views the file holds", () => {
    expect(hasTable(DB, "notes")).toBe(true);
    expect(hasTable(DB, "recent")).toBe(true);
    expect(hasTable(DB, "nope")).toBe(false);
    expect(hasTable(DB, "sqlite_master")).toBe(false);
    expect(hasTable(new Uint8Array([1, 2, 3]), "notes")).toBe(false);
  });
  test("a view that fails shows a note, not nothing", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE t (a)");
    db.run("CREATE VIEW v AS SELECT a FROM t");
    db.run("DROP TABLE t");
    const body = db.serialize();
    db.close();
    const r = draw(body);
    expect(String(r.content)).toContain("could not be read");
  });
  test("the listing scrolls on a phone and has no card", () => {
    const h = String(draw(DB).content);
    expect(h).toContain('<div class="csv-scroll"><table');
    expect(h).not.toContain("card");
  });
  test("200 tables of a ~5 MB file list in bounded work", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < 200; i++) {
      db.run(`CREATE TABLE t${i} (a INTEGER, b TEXT)`);
      db.run(`INSERT INTO t${i} SELECT n, hex(randomblob(60)) FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 150) SELECT n FROM c)`);
    }
    const body = db.serialize();
    db.close();
    const r = draw(body);
    const h = String(r.content);
    // Work, not a clock: one listing row per table, two statements each at most.
    expectWork(h.split("?table=").length - 1, { max: TABLE_CAP });
    expect(h.split("?table=").length - 1).toBe(200);
    expectWork(h.length, { max: 100_000 });
    expect(h).toContain("150 rows");
  });
});
