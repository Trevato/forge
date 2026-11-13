/**
 * Index use (#12011): which index each statement the forge prepares walks.
 *
 *   bun scripts/index-use.ts                 every index, with the statements that use it
 *   bun scripts/index-use.ts --unused        only the indexes nothing uses and nothing keeps
 *   bun scripts/index-use.ts --bytes         …and what each held on a seeded database
 *   bun scripts/index-use.ts --log <file>    add the statements a test run collected
 *
 * The statements come from the source: every string or template literal
 * under `src/` (migrations aside) that reads as SQL, with `${…}` standing
 * in as a bound parameter, plus the statements inside each trigger. A
 * test run adds what it really prepared when `FORGE_SQL_LOG=<file>` is set
 * (`test/helpers/preload.ts` appends each distinct text):
 *
 *   FORGE_SQL_LOG=$TMPDIR/sql.log bun test test/a.test.ts …
 *   bun scripts/index-use.ts --log $TMPDIR/sql.log
 *
 * Each is planned with EXPLAIN QUERY PLAN on a freshly migrated database.
 * The forge never runs ANALYZE, so production plans without statistics too,
 * and the plan seen here is the plan it gets.
 *
 * An index is never offered for dropping when it is UNIQUE (a constraint),
 * partial (a bound value can satisfy its WHERE at run time, which a plan
 * without values cannot show), the lookup a foreign key's checks and
 * cascades walk (those plans are not in EXPLAIN), or named by any file in
 * `src/` or `test/` outside the migrations (a test of a plan, an INDEXED BY).
 */

import type { Database } from "bun:sqlite";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What makes a literal SQL: its first word. */
const SQL_START = /^(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Where a `${…}` stood in a template literal, before a stand-in is chosen. */
const HOLE = "\u0000";

/**
 * The string and template literals of one TypeScript file, with literals
 * joined by `+` read as one, and each `${…}` left as {@link HOLE}.
 */
export function literals(text: string): string[] {
  const found: { start: number; end: number; value: string }[] = [];
  let i = 0;
  // The last significant character, to tell a regular expression from a division.
  let last = "";
  const n = text.length;

  const quoted = (q: string): string => {
    let out = "";
    i++;
    while (i < n && text[i] !== q) {
      if (text[i] === "\\") {
        out += unescape(text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (text[i] === "\n") break;
      out += text[i++];
    }
    i++;
    return out;
  };

  const template = (): string => {
    let out = "";
    i++;
    while (i < n && text[i] !== "`") {
      if (text[i] === "\\") {
        out += unescape(text[i + 1] ?? "");
        i += 2;
      } else if (text[i] === "$" && text[i + 1] === "{") {
        i += 2;
        skipCode("}");
        i++;
        out += HOLE;
      } else out += text[i++];
    }
    i++;
    return out;
  };

  // Walks code until `close` at depth zero; literals inside a `${…}` are still found.
  const skipCode = (close: string | null): void => {
    let depth = 0;
    while (i < n) {
      const c = text[i]!;
      if (close !== null && c === close && depth === 0) return;
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (c === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const start = i;
        const value = c === "`" ? template() : quoted(c);
        found.push({ start, end: i, value });
        last = c;
        continue;
      }
      if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|case)$/.test(text.slice(Math.max(0, i - 7), i).trimEnd()))) {
        i++;
        let inClass = false;
        while (i < n && text[i] !== "\n") {
          if (text[i] === "\\") i++;
          else if (text[i] === "[") inClass = true;
          else if (text[i] === "]") inClass = false;
          else if (text[i] === "/" && !inClass) break;
          i++;
        }
        i++;
        last = "/";
        continue;
      }
      if (!/\s/.test(c)) last = c;
      i++;
    }
  };

  skipCode(null);
  found.sort((a, b) => a.start - b.start);
  const joined: string[] = [];
  let prev: { end: number } | null = null;
  for (const lit of found) {
    if (prev !== null && joined.length > 0 && /^\s*\+\s*$/.test(text.slice(prev.end, lit.start)))
      joined[joined.length - 1] += lit.value;
    else joined.push(lit.value);
    prev = lit;
  }
  return joined;
}

function unescape(c: string): string {
  if (c === "n" || c === "t" || c === "r") return " ";
  if (c === "\n") return "";
  return c;
}

/** The literals of `text` that read as one SQL statement, leading comments dropped. */
export function sqlLiterals(text: string): string[] {
  const out: string[] = [];
  for (const lit of literals(text)) {
    const sql = lit.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "").trim();
    if (SQL_START.test(sql) && /\s/.test(sql)) out.push(sql);
  }
  return out;
}

const scan = (root: string, glob: string) => [...new Bun.Glob(glob).scanSync({ cwd: root })].sort();

/** Every SQL literal under `root`/src outside the migrations, distinct. */
export function sourceStatements(root: string): string[] {
  const all = new Set<string>();
  for (const f of scan(root, "src/**/*.ts")) {
    if (f.startsWith("src/core/migrations/") || f.endsWith(".test.ts")) continue;
    for (const sql of sqlLiterals(readFileSync(join(root, f), "utf8"))) all.add(sql);
  }
  return [...all];
}

/** The statements inside each trigger, with `NEW.x` and `OLD.x` bound. */
export function triggerStatements(db: Database): string[] {
  const out: string[] = [];
  const rows = db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
    .all();
  for (const { sql } of rows) {
    const body = /\bBEGIN\b([\s\S]*)\bEND\s*;?\s*$/i.exec(sql)?.[1];
    if (body === undefined) continue;
    for (const part of body.split(";")) {
      const s = part.replace(/\b(?:NEW|OLD)\.["`]?\w+["`]?/gi, "?").trim();
      if (SQL_START.test(s)) out.push(s);
    }
  }
  return out;
}

/** The forms a `${…}` is tried as, in order, until the statement prepares. */
const STAND_INS = ["?", "1", "", "id"];

/** The index names one statement's plan walks, or null when it prepares in no form. */
export function plannedIndexes(db: Database, sql: string): string[] | null {
  for (const stand of STAND_INS) {
    const text = sql.split(HOLE).join(stand);
    let plan: { detail: string }[];
    try {
      plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${text}`).all();
    } catch {
      continue;
    }
    const names = new Set<string>();
    for (const { detail } of plan)
      for (const m of detail.matchAll(/USING (?:COVERING )?INDEX (\S+)/g)) names.add(m[1]!);
    return [...names];
  }
  return null;
}

export interface IndexRow {
  name: string;
  table: string;
  sql: string;
  /** Why it may never be dropped; empty when nothing keeps it but use. */
  kept: string[];
  /** The statements whose plan walks it. */
  usedBy: string[];
}

export interface IndexUse {
  indexes: IndexRow[];
  /** Statements that prepared in no form (dynamic SQL); counted, not planned. */
  unplanned: string[];
}

/** Each explicit index of `db`, what uses it and what keeps it. */
export function indexUse(db: Database, statements: readonly string[], named: ReadonlySet<string>): IndexUse {
  const rows = db
    .query<{ name: string; tbl_name: string; sql: string }, []>(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY tbl_name, name",
    )
    .all();
  const byName = new Map<string, IndexRow>();
  for (const r of rows)
    byName.set(r.name, { name: r.name, table: r.tbl_name, sql: r.sql, kept: keptBecause(db, r, named), usedBy: [] });
  const unplanned: string[] = [];
  for (const sql of statements) {
    const used = plannedIndexes(db, sql);
    if (used === null) {
      unplanned.push(sql);
      continue;
    }
    for (const name of used) byName.get(name)?.usedBy.push(sql);
  }
  return { indexes: [...byName.values()], unplanned };
}

function keptBecause(db: Database, r: { name: string; tbl_name: string; sql: string }, named: ReadonlySet<string>): string[] {
  const why: string[] = [];
  if (/^\s*CREATE\s+UNIQUE\b/i.test(r.sql)) why.push("unique");
  if (/\)\s*WHERE\b/i.test(r.sql)) why.push("partial");
  const cols = db
    .query<{ name: string | null }, [string]>("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
    .all(r.name)
    .map((c) => c.name);
  const fks = new Map<number, string[]>();
  for (const fk of db
    .query<{ id: number; from: string }, [string]>('SELECT id, "from" FROM pragma_foreign_key_list(?1)')
    .all(r.tbl_name))
    fks.set(fk.id, [...(fks.get(fk.id) ?? []), fk.from]);
  for (const from of fks.values()) {
    const lead = new Set(cols.slice(0, from.length));
    if (from.every((c) => lead.has(c))) {
      why.push("foreign key");
      break;
    }
  }
  if (named.has(r.name)) why.push("named in code");
  return why;
}

/** The index names `src/` and `test/` mention outside the migrations. */
export function namedIndexes(root: string, names: readonly string[]): Set<string> {
  const files = [...scan(root, "src/**/*.ts"), ...scan(root, "test/**/*.ts")].filter(
    (f) => !f.startsWith("src/core/migrations/"),
  );
  const text = files.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const words = new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  return new Set(names.filter((n) => words.has(n)));
}

/** The indexes nothing plans through and nothing keeps. */
export function unusedIndexes(use: IndexUse): IndexRow[] {
  return use.indexes.filter((r) => r.usedBy.length === 0 && r.kept.length === 0);
}

/**
 * A copy of `db` with `rows` rows in every table, values made from each
 * column's declared type, so an index holds what it would hold in use.
 * Checks, foreign keys and triggers are off in the copy: shape, not truth.
 */
export function seeded(db: Database, rows: number): Database {
  const { Database: Db } = require("bun:sqlite") as typeof import("bun:sqlite");
  const copy = Db.deserialize(db.serialize());
  copy.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; PRAGMA journal_mode = MEMORY;");
  for (const { name } of copy.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'").all())
    copy.exec(`DROP TRIGGER "${name}"`);
  const tables = copy
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
    )
    .all();
  copy.exec("BEGIN");
  for (const { name } of tables) {
    const cols = copy
      .query<{ name: string; type: string; hidden: number }, [string]>(
        "SELECT name, type, hidden FROM pragma_table_xinfo(?1) WHERE hidden = 0",
      )
      .all(name);
    // A text is a JSON string, so a generated column that reads JSON reads it.
    try {
      const insert = copy.prepare(
        `INSERT OR IGNORE INTO "${name}" (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      );
      for (let i = 0; i < rows; i++)
        insert.run(...cols.map((c, k) => (/INT|REAL|NUM/i.test(c.type) ? 1_700_000_000_000 + i * 7919 + k : `"${c.name}-${i}-${(i * 2654435761) % 1_000_003}"`)));
    } catch {
      // A table this cannot fill (a full-text shadow, a generated column it cannot satisfy)
      // stays as full as it got; its indexes count what it holds.
    }
  }
  copy.exec("COMMIT");
  return copy;
}

/** The bytes the file of `db` loses when `names` are dropped, after a VACUUM. */
export function bytesHeld(db: Database, names: readonly string[]): number {
  const { Database: Db } = require("bun:sqlite") as typeof import("bun:sqlite");
  const size = (d: Database) => {
    d.exec("VACUUM");
    const { n } = d.query<{ n: number }, []>("SELECT page_count * page_size AS n FROM pragma_page_count, pragma_page_size").get()!;
    return n;
  };
  const without = Db.deserialize(db.serialize());
  for (const name of names) without.exec(`DROP INDEX "${name}"`);
  const before = size(Db.deserialize(db.serialize()));
  return before - size(without);
}

/** Appends `sql` to the file `FORGE_SQL_LOG` names, once per process per text (the test run's collector). */
export function collectInto(file: string): (sql: string) => void {
  const seen = new Set<string>();
  return (sql) => {
    if (seen.has(sql)) return;
    seen.add(sql);
    appendFileSync(file, `${JSON.stringify(sql)}\n`);
  };
}

/** The statements a collector wrote, one JSON string per line. */
export function readLog(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as string)
    .filter((s) => SQL_START.test(s.trim()));
}

if (import.meta.main) {
  const { openDb } = await import("../src/kernel/db.ts");
  const { migrations } = await import("../src/core/schema.ts");
  const args = process.argv.slice(2);
  const root = join(import.meta.dir, "..");
  const db = openDb(":memory:", migrations);
  const statements = new Set([...sourceStatements(root), ...triggerStatements(db)]);
  for (let k = 0; k < args.length; k++) if (args[k] === "--log") for (const s of readLog(args[++k]!)) statements.add(s);
  const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all().map((r) => r.name);
  const use = indexUse(db, [...statements], namedIndexes(root, names));
  const unused = unusedIndexes(use);
  const one = (s: string) => s.replace(/\s+/g, " ").replaceAll(HOLE, "${…}").slice(0, 160);
  // CLI answer for the person at the terminal.
  if (args.includes("--unused") || args.includes("--bytes")) {
    const seed = args.includes("--bytes") ? seeded(db, 1000) : null;
    let total = 0;
    for (const r of unused) {
      const bytes = seed === null ? null : bytesHeld(seed, [r.name]);
      total += bytes ?? 0;
      console.log(bytes === null ? `${r.name}\t${r.table}` : `${r.name}\t${r.table}\t${bytes}`);
    }
    if (seed !== null) console.log(`total\t${unused.length} indexes\t${bytesHeld(seed, unused.map((r) => r.name))} bytes (sum of each alone ${total}) at 1000 rows a table`);
  } else {
    for (const r of use.indexes) {
      console.log(`${r.name} on ${r.table}${r.kept.length > 0 ? ` (kept: ${r.kept.join(", ")})` : ""}: ${r.usedBy.length} statements`);
      for (const s of r.usedBy) console.log(`  ${one(s)}`);
    }
  }
  console.error(
    `index-use: ${statements.size} statements, ${use.unplanned.length} would not prepare, ${use.indexes.length} indexes, ${unused.length} unused`,
  );
}
