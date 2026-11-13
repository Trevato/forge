/**
 * Loading a SQL dump into an app's SQLite store, and proving it arrived.
 *
 * A dump is text a person uploaded, so it is never run as given. It is split
 * into statements (quotes and comments respected) and only a short list of
 * kinds may run: `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `INSERT INTO`,
 * `BEGIN`/`COMMIT`, and `PRAGMA foreign_keys`. `ATTACH`, other `PRAGMA`s,
 * triggers, views, `DROP`, `UPDATE` and `DELETE` are refused with the
 * statement's number, before anything is written.
 *
 * The kinds are narrower than their first words. An `INSERT` is only
 * `INSERT INTO <table> [(columns)] VALUES (...)[, (...)]`, its values
 * literals (numbers, strings, `X'..'` blobs, NULL, TRUE, FALSE): no function
 * call, no `SELECT`, no `WITH`. A `CREATE TABLE` is never `AS`. `SELECT` and
 * `WITH` are refused anywhere outside quotes, and so are the functions that
 * make a big value out of a small statement (`randomblob`, `zeroblob`,
 * `printf`, `replace`...). What is left costs time and disk in proportion to
 * the bytes of the dump: it is capped at 16 MB by the route, at
 * `MAX_STATEMENTS` statements here, and each database at `MAX_PAGES` pages.
 *
 * It is loaded twice, on purpose: into a scratch in-memory database (the
 * dump side) and into a new file beside the target (the store side). Each
 * side reports, per table, its row count and a SHA-256 of its rows in rowid
 * order, every value written as SQLite's own `quote()` literal so integers,
 * reals, text and blobs each hash by type. The two loads agree on the hash,
 * and each table's row count agrees with the number of `VALUES` tuples
 * counted in the dump's text, which SQLite did not produce. The file
 * replaces the target only when all of that holds.
 *
 * The input is the dump `sqlite3 .dump` writes, or `pg_dump --inserts
 * --no-owner` made SQLite-compatible; a Postgres app's home is #11698.
 */

import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** A table's rows as one side holds them. */
export interface TableFingerprint {
  readonly table: string;
  readonly rows: number;
  /** SHA-256, hex, of the rows in rowid order. */
  readonly sha256: string;
}

export interface TableCompare extends TableFingerprint {
  /** The same table as the store holds it. */
  readonly store: TableFingerprint | undefined;
  /** Rows the dump's own text says were inserted, counted from its `VALUES` lists. */
  readonly inserted: number;
  readonly match: boolean;
}

export type ImportError =
  | { readonly error: "empty" }
  | { readonly error: "refused"; readonly statement: number; readonly kind: string }
  | { readonly error: "invalid"; readonly statement: number; readonly message: string }
  | { readonly error: "mismatch"; readonly tables: readonly TableCompare[] }
  | { readonly error: "too_large"; readonly statements: number }
  | { readonly error: "exists"; readonly file: string };

export interface ImportReport {
  readonly file: string;
  readonly statements: number;
  /** One per table: the dump side, then what the store holds. */
  readonly tables: readonly TableCompare[];
  /** The file the replaced database was kept as, when there was one. */
  readonly kept?: string;
}

/**
 * Split SQL at top-level semicolons. Single, double and backtick quotes
 * (doubled to escape), `--` and block comments are understood; comments are
 * dropped. Empty statements are not returned.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      cur += " ";
    } else if (c === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Statements one dump may hold: a 16 MB dump of `INSERT INTO t VALUES(1);` is about 700,000. */
export const MAX_STATEMENTS = 1_000_000;
/** Pages either database may grow to: 16,384 x 4 KiB = 64 MiB. */
export const MAX_PAGES = 16_384;

const NAME = String.raw`(?:"(?:[^"]|"")+"|` + "`(?:[^`]|``)+`" + String.raw`|\[[^\]]+\]|\w+)`;
const ALLOWED: readonly RegExp[] = [
  /^BEGIN(\s+(DEFERRED\s+|IMMEDIATE\s+|EXCLUSIVE\s+)?TRANSACTION)?$/i,
  /^(COMMIT|END)(\s+TRANSACTION)?$/i,
  /^PRAGMA\s+foreign_keys\s*=\s*(ON|OFF|0|1)$/i,
  /^CREATE\s+TABLE\s/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX\s/i,
];
const INSERT = new RegExp(String.raw`^INSERT\s+INTO\s+(${NAME})\s*(\([^()]*\))?\s*VALUES\s*(\(.*)$`, "is");
const CREATE_TABLE_AS = new RegExp(String.raw`^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s+AS\b`, "i");
/** Words that make a lot out of a little, or read the machine; none belongs in a dump. */
const HEAVY = /\b(select|with)\b|\b(randomblob|zeroblob|printf|format|replace|hex|unhex|load_extension|readfile|writefile|generate_series|json_each|json_tree|group_concat)\s*\(/i;
const LITERAL_WORD = /^(null|true|false|x)$/i;

/** `sql` with every quoted piece emptied, so what is left is syntax. */
function bare(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += c + c;
      i = j + 1;
    } else if (c === "[") {
      const end = sql.indexOf("]", i);
      out += "[]";
      i = end === -1 ? sql.length : end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The tuples of a VALUES list: how many, or undefined when it is not only literals. */
function valueTuples(tail: string): number | undefined {
  const syntax = bare(tail);
  if (/[A-Za-z_]\w*\s*\(/.test(syntax.replace(/(?<![\w.])[xX](?=')/g, ""))) return undefined; // a call
  for (const w of syntax.match(/(?<![\w.])[A-Za-z_]\w*/g) ?? []) if (!LITERAL_WORD.test(w)) return undefined;
  if (!/^[\s\d.,()+\-'"xXeE\w]*$/.test(syntax)) return undefined;
  let depth = 0;
  let tuples = 0;
  let expectComma = false;
  for (const ch of syntax) {
    if (ch === "(") {
      if (depth === 0) {
        if (expectComma) return undefined;
        tuples++;
      }
      if (++depth > 1) return undefined;
    } else if (ch === ")") {
      if (--depth < 0) return undefined;
      if (depth === 0) expectComma = true;
    } else if (depth === 0 && ch === ",") expectComma = false;
    else if (depth === 0 && !/\s/.test(ch)) return undefined;
  }
  return depth === 0 && tuples > 0 ? tuples : undefined;
}

const tableKey = (raw: string): string => {
  const t = raw.trim();
  const inner = /^"(.*)"$/s.test(t) ? t.slice(1, -1).replaceAll('""', '"')
    : /^`(.*)`$/s.test(t) ? t.slice(1, -1).replaceAll("``", "`")
    : /^\[(.*)\]$/s.test(t) ? t.slice(1, -1)
    : t;
  return inner.toLowerCase();
};

/** Rows each table should hold, counted from the dump's own text: the independent side of the proof. */
export function insertedRows(statements: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of statements) {
    const m = INSERT.exec(s);
    if (!m) continue;
    const n = valueTuples(m[3]!) ?? 0;
    const key = tableKey(m[1]!);
    counts.set(key, (counts.get(key) ?? 0) + n);
  }
  return counts;
}

const kindOf = (s: string): string => s.split(/\s+/).slice(0, 2).join(" ").slice(0, 40);

/** The first statement that may not run, as its 1-based number and first words. */
export function firstRefused(
  statements: readonly string[],
): { statement: number; kind: string } | undefined {
  for (const [i, s] of statements.entries()) {
    const refuse = { statement: i + 1, kind: kindOf(s) };
    if (/^INSERT\s/i.test(s)) {
      const m = INSERT.exec(s);
      if (!m || valueTuples(m[3]!) === undefined) return refuse;
      continue;
    }
    if (!ALLOWED.some((re) => re.test(s)) || CREATE_TABLE_AS.test(s) || HEAVY.test(bare(s))) return refuse;
  }
  return undefined;
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Row count and checksum of every user table, by name. */
export function fingerprint(db: Database): TableFingerprint[] {
  const names = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return names.map(({ name }) => {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(${ident(name)})`)
      .all();
    const select = columns.map((c) => `quote(${ident(c.name)})`).join(", ");
    const hasher = new Bun.CryptoHasher("sha256");
    let rows = 0;
    const read = (order: string) => {
      const query = db.query(`SELECT ${select} FROM ${ident(name)}${order}`).values();
      for (const row of query) {
        hasher.update(`${row.join("\x1f")}\n`);
        rows++;
      }
    };
    try {
      read(" ORDER BY rowid");
    } catch {
      // WITHOUT ROWID: a scan walks the primary key, which is its order.
      read("");
    }
    return { table: name, rows, sha256: hasher.digest("hex") };
  });
}

function run(
  db: Database,
  statements: readonly string[],
): { statement: number; message: string } | undefined {
  for (const [i, s] of statements.entries()) {
    try {
      db.exec(s);
    } catch (e) {
      return { statement: i + 1, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return undefined;
}

export const IMPORT_FILE = /^[\w.-]+\.db$/;

/** The row counts of a store against the dump's: pure, so the proof can be tried on its own. */
export function compareTables(
  dumpSide: readonly TableFingerprint[],
  storeSide: readonly TableFingerprint[],
  inserted: ReadonlyMap<string, number>,
): TableCompare[] {
  const store = new Map(storeSide.map((t) => [t.table, t]));
  return dumpSide.map((t): TableCompare => {
    const s = store.get(t.table);
    const counted = inserted.get(t.table.toLowerCase()) ?? 0;
    return {
      ...t,
      store: s,
      inserted: counted,
      match: s?.rows === t.rows && s.sha256 === t.sha256 && s.rows === counted,
    };
  });
}

/** A name for the replaced file that no earlier import's backup holds. */
function backupName(dir: string, file: string, now: number): string {
  for (let n = 0; ; n++) {
    const name = `${file}.before-import-${now}${n === 0 ? "" : `-${n}`}`;
    if (!existsSync(join(dir, name))) return name;
  }
}

/**
 * Load `sql` as `<dir>/<file>`. `dir` is an environment's data directory,
 * built by the caller from ids, never from input. An existing file is kept
 * (`<file>.before-import-<ms>`, a name no earlier backup has) only when
 * `replace` is set, else refused. The target is never absent: the old file
 * is hard-linked to its backup, then the new one is renamed over it.
 * `afterLoad` is a seam for tests: it may touch the store before the proof.
 */
export function importDump(
  dir: string,
  file: string,
  sql: string,
  replace: boolean,
  afterLoad?: (store: Database) => void,
  now: number = Date.now(),
): { ok: true; value: ImportReport } | { ok: false; error: ImportError } {
  const statements = splitSql(sql);
  if (statements.length === 0) return { ok: false, error: { error: "empty" } };
  if (statements.length > MAX_STATEMENTS)
    return { ok: false, error: { error: "too_large", statements: statements.length } };
  const refused = firstRefused(statements);
  if (refused) return { ok: false, error: { error: "refused", ...refused } };
  const target = join(dir, file);
  if (existsSync(target) && !replace)
    return { ok: false, error: { error: "exists", file } };

  const scratch = new Database(":memory:");
  const staged = join(dir, `${file}.importing`);
  mkdirSync(dir, { recursive: true });
  for (const p of [staged, `${staged}-wal`, `${staged}-shm`]) rmSync(p, { force: true });
  const store = new Database(staged, { create: true });
  try {
    for (const side of [scratch, store]) {
      side.exec(`PRAGMA max_page_count = ${MAX_PAGES}`);
      const failed = run(side, statements);
      if (failed) return { ok: false, error: { error: "invalid", ...failed } };
    }
    afterLoad?.(store);
    const tables = compareTables(fingerprint(scratch), fingerprint(store), insertedRows(statements));
    if (tables.some((t) => !t.match) || fingerprint(store).length !== tables.length)
      return { ok: false, error: { error: "mismatch", tables } };
    store.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
    let kept: string | undefined;
    if (existsSync(target)) {
      try {
        const old = new Database(target, { readwrite: true });
        old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        old.close();
      } catch {
        // Not SQLite after all: it is kept as it is.
      }
      kept = backupName(dir, file, now);
      linkSync(target, join(dir, kept));
    }
    for (const suffix of ["-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
    renameSync(staged, target);
    return {
      ok: true,
      value: { file, statements: statements.length, tables, ...(kept ? { kept } : {}) },
    };
  } finally {
    scratch.close();
    try {
      store.close();
    } catch {
      // Already closed.
    }
    for (const p of [staged, `${staged}-wal`, `${staged}-shm`]) rmSync(p, { force: true });
  }
}
