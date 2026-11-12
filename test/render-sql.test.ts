import { describe, expect, test } from "bun:test";
import { fileKind, NO_BYTES } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";
import { parseSql, ROW_CAP, sqlView } from "../src/web/render/sql.ts";

const draw = (text: string) => {
  const body = new TextEncoder().encode(text);
  const r = sqlView({ path: "db/001.sql", size: body.length, body, media: "", download: "" });
  return { html: String(r.content), summary: r.summary, fallback: r.fallback };
};

describe("sql", () => {
  test("a .sql file is its own kind with a renderer", () => {
    expect(fileKind("db/001.sql", NO_BYTES)).toBe("sql");
    expect(RENDERERS.sql).toBe(sqlView);
  });

  test("a table with constraints", () => {
    const doc = parseSql(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name VARCHAR(20, 2) DEFAULT 'a,b',
        org_id INT,
        created TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (org_id) REFERENCES orgs(id)
      );
      CREATE INDEX idx ON users(email);`,
    )!;
    expect(doc.total).toBe(2);
    const t = doc.statements[0]!;
    if (t.kind !== "table") throw new Error("table");
    expect(t.name).toBe("users");
    expect(t.columns.map((c) => [c.name, c.type, c.notNull, c.primaryKey, c.default])).toEqual([
      ["id", "INTEGER", true, true, ""],
      ["email", "TEXT", true, false, ""],
      ["name", "VARCHAR(20, 2)", false, false, "'a,b'"],
      ["org_id", "INT", false, false, ""],
      ["created", "TEXT", true, false, "(datetime('now'))"],
    ]);
    expect(t.extras).toEqual(["FOREIGN KEY (org_id) REFERENCES orgs(id)"]);
    expect(doc.statements[1]).toEqual({ kind: "other", line: "CREATE INDEX idx ON users(email)" });
  });

  test("a table-level primary key marks its columns", () => {
    const t = parseSql("CREATE TABLE m (a INT, b INT, PRIMARY KEY (a, b));")!.statements[0]!;
    if (t.kind !== "table") throw new Error("table");
    expect(t.columns.map((c) => c.primaryKey)).toEqual([true, true]);
  });

  test("comments are not statements and may hide semicolons", () => {
    const doc = parseSql("-- first; second\n/* CREATE TABLE no (x int); */\nALTER TABLE a ADD COLUMN b INT; -- done\n")!;
    expect(doc.statements).toEqual([{ kind: "other", line: "ALTER TABLE a ADD COLUMN b INT" }]);
  });

  test("a quoted name with < is escaped", () => {
    const out = draw('CREATE TABLE "<img src=x onerror=alert(1)>" ("<b>" TEXT);\nALTER TABLE "<i>" ADD x INT;').html;
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<i>");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("renders a block per statement with a summary", () => {
    const r = draw("CREATE TABLE t (id INT NOT NULL);\nDROP TABLE u;");
    expect(r.html).toContain("<h3>");
    expect(r.html).toContain("NOT NULL");
    expect(r.summary).toContain("2 statements");
    expect(r.fallback).toBeUndefined();
  });

  test("an unparsable file falls back to the source", () => {
    for (const text of ["just some prose, nothing here", "", "SELECT 'unterminated;", "/* never closed\nCREATE TABLE a (x int);"]) {
      const r = draw(text);
      expect(r.fallback).toBeDefined();
    }
  });

  test("a malformed CREATE TABLE is one row, not an error", () => {
    const doc = parseSql("CREATE TABLE broken (a INT, ;\nCREATE TABLE t2;")!;
    expect(doc.statements.every((s) => s.kind === "other")).toBe(true);
  });

  test("the cap", () => {
    const text = Array.from({ length: ROW_CAP + 25 }, (_, i) => `CREATE INDEX i${i} ON t(a);`).join("\n");
    const r = draw(text);
    expect(r.html).toContain("25 more not shown");
    expect(r.html.match(/<table/g)?.length).toBe(ROW_CAP);
  });

  test("every table sits in a scroll wrapper and is named", () => {
    const r = draw("CREATE TABLE t (a INT);\nDROP TABLE x;");
    expect(r.html.match(/<div class="table-scroll"><table/g)?.length).toBe(2);
    expect(r.html).toContain('aria-label="Statement"');
  });

  test("the column cap", () => {
    const cols = Array.from({ length: 520 }, (_, i) => `c${i} INT`).join(",");
    const doc = parseSql(`CREATE TABLE wide (${cols});`)!;
    expect((doc.statements[0] as unknown as { columns: unknown[] }).columns.length).toBe(500);
  });

  test("a $$ body is one statement", () => {
    const doc = parseSql("CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; SELECT 2; $$ LANGUAGE sql;\nCREATE TABLE t (a INT);")!;
    expect(doc.total).toBe(2);
  });
});
