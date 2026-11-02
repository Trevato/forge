/**
 * Which migrations a database has applied — by what each one says, not by
 * where it sits in the list.
 *
 * A position is not an identity. Two pulls that each append a migration
 * both call theirs N+1; whichever lands second is renumbered N+2 by its
 * rebase. A preview keeps its data across redeploys, so a database that ran
 * the branch's migration as N+1 then booted the rebased build, saw
 * `user_version = N+1`, and ran the same CREATE again as N+2: "table already
 * exists", and a preview that never came up (#558). So every applied
 * migration is a row in `schema_migration`, keyed by a hash of its text, and
 * a boot runs exactly the ones whose text it has not seen. A second boot is
 * a no-op; a migration that moved is still recognised; a sibling's migration
 * this build does not know is left alone and named, never a refusal to boot
 * (#783) — each row also carries its migration's file name.
 *
 * Each statement is also run so that meeting its own result is a no-op —
 * `CREATE` gains `IF NOT EXISTS`, an `ADD COLUMN` whose column is there is
 * skipped — because data written by the positional runner can hold a
 * branch's table under the wrong number, and a migration recorded nowhere
 * may still have left its mark.
 *
 * `user_version` is still written — the count of applied migrations — so a
 * build from before this table refuses a database that is ahead of it the
 * way it always did.
 */

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defect } from "./error.ts";
import { sha256 } from "./hash.ts";

/** The longest slice of a failing statement a failure message quotes. */
const QUOTE_MAX = 80;

/**
 * A migration file's name: a sortable id — `0001` to `0090` for the ones
 * that were numbered in a list, a UTC `YYYYMMDDHHMMSS` for every one since
 * — then a slug. Both kinds sort as text: every numbered id starts `0`, every
 * stamped one `2`.
 */
export const MIGRATION_FILE = /^(0\d{3}|\d{14})-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;

/** A migration as its file holds it: the name without `.ts`, and its SQL. */
export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/**
 * The migrations in `dir`, one file each, in the order their names sort.
 * Each file's default export is its SQL. Read once, at boot, synchronously:
 * the list is the schema, so a name that does not fit or a file that
 * exports no SQL is a defect, never a migration quietly skipped.
 */
export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .sort()
    .map((file) => {
      if (!MIGRATION_FILE.test(file))
        defect(
          "db.migration_name",
          `${file} in ${dir} is not <id>-<slug>.ts (id: 0NNN or YYYYMMDDHHMMSS)`,
        );
      const sql: unknown = require(join(dir, file)).default;
      if (typeof sql !== "string")
        defect("db.migration_missing", `${file} has no default export of SQL`);
      return { name: file.slice(0, -".ts".length), sql };
    });
}

/**
 * A migration's identity: its text with runs of whitespace collapsed, so
 * re-indenting a released migration does not make it new.
 */
export function migrationId(sql: string): string {
  return sha256(sql.replace(/\s+/g, " ").trim());
}

/** Each pinned migration's id, by name: what it said when it was pinned. */
export type MigrationPins = Readonly<Record<string, string>>;

/**
 * Every pin: `legacy` (the one file that held them all, now frozen) and one
 * `<name>.pin` file in `dir` per migration since, holding its id. The pull
 * that adds a migration adds its pin file, so pins never meet in a shared
 * file and never wait for a release.
 */
export function readPins(dir: string, legacy: MigrationPins): MigrationPins {
  const all: Record<string, string> = { ...legacy };
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".pin"))
      defect("db.migration_name", `${file} in ${dir} is not <name>.pin`);
    const name = file.slice(0, -".pin".length);
    if (name in legacy)
      defect("db.pin_repinned", `${file} would re-pin ${name}, which is already pinned`);
    const id = readFileSync(join(dir, file), "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(id))
      defect("db.pin_malformed", `${file} does not hold a sha256 id`);
    all[name] = id;
  }
  return all;
}

/**
 * How `files` differ from what was pinned: one line for each pinned
 * migration whose text says something else now, or that is gone. A
 * migration on main is history — an edited one is a new one, and a
 * database that ran the old text runs the new one again on top of it.
 */
export function pinBreaks(
  files: readonly MigrationFile[],
  pins: MigrationPins,
): string[] {
  const now = new Map(files.map((m) => [m.name, migrationId(m.sql)]));
  const breaks: string[] = [];
  for (const [name, id] of Object.entries(pins)) {
    const current = now.get(name);
    if (current === undefined) breaks.push(`${name} was pinned and is gone`);
    else if (current !== id)
      breaks.push(`${name} was edited after it was pinned — add a new migration instead`);
  }
  return breaks;
}

/**
 * A migration as `migrate` takes it: its file, which names it, or bare SQL —
 * a test's own list — which is known by its position alone.
 */
export type Migration = string | MigrationFile;

/** What a boot did to the database, by migration name. */
export interface Migrated {
  /** The migrations this boot applied, in the order it applied them. */
  readonly applied: string[];
  /**
   * What the database has applied that this build does not know: a newer
   * build's or a sibling branch's, on data copied for a preview. Each by
   * the name its build recorded; one recorded with none by its position and
   * the start of its id. Left alone, never undone.
   */
  readonly unknown: string[];
}

export function migrate(db: Database, list: readonly Migration[]): Migrated {
  const migrations = list.map((m) => (typeof m === "string" ? m : m.sql));
  const names = list.map((m, i) =>
    typeof m === "string" ? `migration ${i + 1}` : `migration ${m.name}`,
  );
  const ids = migrations.map((sql, i) => {
    if (sql.trim() === "")
      defect("db.migration_missing", `${names[i]} is empty`);
    return migrationId(sql);
  });
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id))
      defect(
        "db.migration_duplicate",
        `${names[i]} repeats an earlier one word for word — it would never run`,
      );
    seen.add(id);
  });

  const applied = appliedIds(db, migrations, ids);
  recordNames(db, list, ids);
  const ran: string[] = [];
  for (let i = 0; i < migrations.length; i++) {
    const id = ids[i]!;
    if (applied.has(id)) continue;
    const sql = migrations[i]!;
    const entry = list[i]!;
    db.transaction(() => {
      for (const statement of statements(sql)) {
        try {
          if (!alreadyAdded(db, statement)) db.exec(idempotent(statement));
        } catch (error) {
          defect(
            "db.migration_failed",
            `${names[i]} failed at ${quote(statement)}: ${messageOf(error)}`,
            error,
          );
        }
      }
      db.query(
        "INSERT INTO schema_migration (id, position, applied_at, name) VALUES (?1, ?2, ?3, ?4)",
      ).run(
        id,
        i + 1,
        new Date().toISOString(),
        typeof entry === "string" ? null : entry.name,
      );
      applied.add(id);
      // PRAGMA can't be parameterized; the value is a count, not input.
      db.exec(`PRAGMA user_version = ${applied.size}`);
    })();
    ran.push(typeof entry === "string" ? String(i + 1) : entry.name);
  }
  const known = new Set(ids);
  const unknown = db
    .query<{ id: string; position: number; name: string | null }, []>(
      "SELECT id, position, name FROM schema_migration ORDER BY position, id",
    )
    .all()
    .filter((row) => !known.has(row.id))
    .map((row) => row.name ?? `#${row.position} (${row.id.slice(0, 12)})`);
  return { applied: ran, unknown };
}

/**
 * Write each known migration's name beside its id, where a build from
 * before names were recorded left none — so the database says which
 * migrations it has by name, and a later build that does not know one can
 * say which. A database written by test lists keeps its blanks.
 */
function recordNames(
  db: Database,
  list: readonly Migration[],
  ids: readonly string[],
): void {
  if (!hasColumn(db, "schema_migration", "name"))
    db.exec("ALTER TABLE schema_migration ADD COLUMN name TEXT");
  const blank = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM schema_migration WHERE name IS NULL",
    )
    .get()!.n;
  if (blank === 0) return;
  const name = db.query(
    "UPDATE schema_migration SET name = ?2 WHERE id = ?1 AND name IS NULL",
  );
  db.transaction(() => {
    list.forEach((m, i) => {
      if (typeof m !== "string") name.run(ids[i]!, m.name);
    });
  })();
}

/**
 * The ids this database has applied. A database from before the table
 * existed has only `user_version`; its first `user_version` migrations are
 * taken as applied — what that number always meant — unless one plainly
 * did not run (a table it creates or a column it adds is missing: a
 * branch's migration sat at that number instead). They are written down
 * once, after which positions never matter again. Such a database ahead of
 * this build is still refused: a count names nothing, so there is no
 * telling which of its migrations this build lacks.
 */
function appliedIds(
  db: Database,
  migrations: readonly string[],
  ids: readonly string[],
): Set<string> {
  if (!hasTable(db, "schema_migration")) {
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0;
    if (version > ids.length) {
      defect(
        "db.future_schema",
        `database is at schema ${version}, this build only knows ${ids.length} — refusing to run`,
      );
    }
    db.transaction(() => {
      db.exec(`CREATE TABLE schema_migration (
        id         TEXT PRIMARY KEY,
        position   INTEGER NOT NULL,
        applied_at TEXT NOT NULL,
        name       TEXT
      )`);
      const insert = db.query(
        "INSERT INTO schema_migration (id, position, applied_at) VALUES (?1, ?2, ?3)",
      );
      const at = new Date().toISOString();
      for (let i = 0; i < version; i++)
        if (leftItsMark(db, migrations.slice(i, version)))
          insert.run(ids[i]!, i + 1, at);
    })();
  }
  return new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM schema_migration")
      .all()
      .map((row) => row.id),
  );
}

const CREATE_RE =
  /^(CREATE\s+(?:UNIQUE\s+|TEMP\s+|TEMPORARY\s+|VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW))\s+(?!IF\s+NOT\s+EXISTS\b)/i;
const CREATE_TABLE_RE =
  /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+|VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)/i;
const ADD_COLUMN_RE =
  /^ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`[]?(\w+)/i;

/** A `CREATE` that meets its own object does nothing instead of failing. */
export function idempotent(statement: string): string {
  return statement.replace(CREATE_RE, "$1 IF NOT EXISTS ");
}

/** An `ADD COLUMN` whose column the table already has. */
function alreadyAdded(db: Database, statement: string): boolean {
  const match = ADD_COLUMN_RE.exec(statement);
  return match !== null && hasColumn(db, match[1]!, match[2]!);
}

const GONE_RE =
  /^(?:DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`[]?(\w+)|ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+RENAME\s+TO\b)/i;

/**
 * The first of `run` (a migration and the ones applied after it) left its
 * mark: every table it creates exists and every column it adds is there —
 * except on tables it or a later one drops or renames away.
 */
function leftItsMark(db: Database, run: readonly string[]): boolean {
  const gone = new Set(
    run
      .flatMap(statements)
      .map((statement) => {
        const match = GONE_RE.exec(statement);
        return (match?.[1] ?? match?.[2])?.toLowerCase();
      })
      .filter((name) => name !== undefined),
  );
  for (const statement of statements(run[0]!)) {
    const table = CREATE_TABLE_RE.exec(statement);
    if (table && !gone.has(table[1]!.toLowerCase()) && !hasTable(db, table[1]!))
      return false;
    const column = ADD_COLUMN_RE.exec(statement);
    if (
      column &&
      !gone.has(column[1]!.toLowerCase()) &&
      !hasColumn(db, column[1]!, column[2]!)
    )
      return false;
  }
  return true;
}

function hasTable(db: Database, name: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1",
      )
      .get(name)!.n === 1
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM pragma_table_info(?1) WHERE name = ?2 COLLATE NOCASE",
      )
      .get(table, column)!.n === 1
  );
}

/**
 * A migration's statements, one at a time, so a failure can name the one
 * that failed. Splits on `;` outside quotes and comments; a trigger body
 * (`CREATE TRIGGER … BEGIN …; END`) stays one statement.
 */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      const end = sql.indexOf(close, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ";") {
      const trimmed = current.trim();
      const openTrigger =
        /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(trimmed) &&
        !/\bEND$/i.test(trimmed);
      if (openTrigger) {
        current += ch;
      } else {
        if (trimmed !== "") out.push(trimmed);
        current = "";
      }
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

/** A statement as one short line: whitespace collapsed, long ones cut. */
function quote(statement: string): string {
  const line = statement.replace(/\s+/g, " ").trim();
  return `"${line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX)}…` : line}"`;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What in a migration the release before it could not keep serving under.
 * During a roll the old process and the new one share one database for a
 * while (docs/ARCHITECTURE.md, "Two processes at once"): the new one
 * migrates, the old one keeps reading with the queries it was built with.
 * So a migration only adds — a table, a column with a default, an index, a
 * row — and removing or renaming waits for the release after the one that
 * stopped reading it. This names each statement that breaks that, by what
 * it does, so a test can refuse it before it ships. Values in quotes are
 * data and are not read.
 */
export function notAdditive(sql: string): string[] {
  // One pass, left to right, as SQLite reads it: a string is data, a quoted
  // name is one word, and either kind of comment is whitespace — whichever
  // starts first wins, so a quote inside a comment opens nothing.
  const code = sql.replace(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*/g,
    (token) =>
      token.startsWith("'") ? "''" : token.startsWith('"') ? "name" : " ",
  );
  const found: string[] = [];
  const say = (what: string, pattern: RegExp): void => {
    if (pattern.test(code)) found.push(what);
  };
  say("drops a table", /\bDROP\s+TABLE\b/i);
  say("drops a view", /\bDROP\s+VIEW\b/i);
  say("drops a trigger", /\bDROP\s+TRIGGER\b/i);
  // `COLUMN` is optional after ALTER TABLE … DROP / RENAME / ADD.
  const alter = /\bALTER\s+TABLE\s+\S+\s+/i.source;
  say("drops a column", new RegExp(`${alter}DROP\\b`, "i"));
  say("renames a table or a column", new RegExp(`${alter}RENAME\\b`, "i"));
  for (const clause of code.match(new RegExp(`${alter}ADD\\b[^;]*`, "gi")) ?? [])
    if (/\bNOT\s+NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause))
      found.push("adds a NOT NULL column without a default");
  return found;
}
