/**
 * Migrations are tracked by what they say, not where they sit (#558).
 *
 * A preview starts from a copy of production's data and keeps it across
 * redeploys. The shapes that killed previews at boot with "table already
 * exists" are each a boot here, on a copy of real forge data: the same build
 * twice, a branch whose migration was renumbered by its rebase, and a branch
 * that adds a table the data already has. A failure names its statement in
 * one line, which is what the deploy's summary on the pull shows.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../src/kernel/db.ts";
import { ForgeError } from "../src/kernel/error.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { migrationId, readMigrations, statements } from "../src/kernel/migrate.ts";
import { migrationFiles, migrations, NUMBERED } from "../src/core/schema.ts";
import { failureReason } from "../src/apps/process.ts";

const root = mkdtempSync(join(tmpdir(), "forge-schema-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = (): string => join(root, `db-${++n}`);

/** Production's data, closed and checkpointed, ready to be copied. */
function production(list: readonly string[]): string {
  const path = fresh();
  const db = openDb(path, list);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return path;
}

/** What `apps/data.ts` does for a preview: a copy of production's file. */
function copyOf(path: string): string {
  const target = fresh();
  copyFileSync(path, target);
  return target;
}

function boot(path: string, list: readonly string[]): void {
  openDb(path, list).close();
}

function has(db: Database, table: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1",
      )
      .get(table)!.n === 1
  );
}

const ownTable = "CREATE TABLE branch_note (id TEXT PRIMARY KEY, body TEXT NOT NULL)";
const mainTable = "CREATE TABLE main_note (id TEXT PRIMARY KEY)";

describe("a preview booting on copied data", () => {
  test("boots, and boots again: the second boot is a no-op", () => {
    const preview = copyOf(production(migrations));
    boot(preview, migrations);
    const db = openDb(preview, migrations);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migration").get()!.n,
    ).toBe(migrations.length);
    db.close();
  });

  test("a branch's migration renumbered by its rebase is not run twice", () => {
    const prod = production(migrations);
    // The branch's first push: its own table as the next migration.
    const preview = copyOf(prod);
    boot(preview, [...migrations, ownTable]);
    // Main lands a migration of its own; the branch rebases onto it and
    // its table is now one further down the list. The preview keeps its
    // data, so the same CREATE meets a database that already ran it.
    boot(preview, [...migrations, mainTable, ownTable]);
    const db = openDb(preview, [...migrations, mainTable, ownTable]);
    expect(has(db, "branch_note")).toBe(true);
    expect(has(db, "main_note")).toBe(true);
    db.close();
  });

  test("a branch that adds a table on data that already has it boots", () => {
    // Preview data written by the positional runner: the branch's table
    // ran as migration N+1 and user_version says N+1. The branch rebases
    // onto main's own N+1; its table is now N+2 and already exists.
    const path = copyOf(production(migrations));
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const old = new Database(path, { strict: true });
    old.exec("DROP TABLE schema_migration");
    old.exec(ownTable);
    old.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    old.close();
    const rebased = [...migrations, mainTable, ownTable];
    boot(path, rebased);
    const db = openDb(path, rebased);
    expect(has(db, "branch_note")).toBe(true);
    expect(has(db, "main_note")).toBe(true);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migration").get()!.n,
    ).toBe(rebased.length);
    db.close();
  });

  test("a column that is already there is not added twice", () => {
    const path = production(["CREATE TABLE a (x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT"]);
    // The same column, under a migration this database has not recorded.
    boot(path, [
      "CREATE TABLE a (x INTEGER)",
      "ALTER TABLE a ADD COLUMN y TEXT",
      "ALTER TABLE a ADD COLUMN y TEXT NOT NULL DEFAULT ''",
    ]);
  });

  test("data from before the tracking table counts its user_version as applied", () => {
    // A database written by the positional runner: user_version alone.
    const path = fresh();
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const old = new Database(path, { create: true, strict: true });
    old.exec("CREATE TABLE a (x INTEGER)");
    old.exec("PRAGMA user_version = 1");
    old.close();
    const db = openDb(path, ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"]);
    expect(has(db, "b")).toBe(true);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(2);
    db.close();
  });

  test("production's own data from before the tracking table adopts every migration", () => {
    const path = copyOf(production(migrations));
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const old = new Database(path, { strict: true });
    old.exec("DROP TABLE schema_migration");
    old.close();
    const db = openDb(path, migrations);
    const positions = db
      .query<{ position: number }, []>("SELECT position FROM schema_migration ORDER BY position")
      .all()
      .map((row) => row.position);
    // Every migration recorded once, at its own position.
    expect(positions).toEqual(migrations.map((_, i) => i + 1));
    db.close();
  });

  test("data ahead of this build is still refused", () => {
    const path = production(["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"]);
    expect(() => openDb(path, ["CREATE TABLE a (x INTEGER)"])).toThrow(ForgeError);
  });
});

describe("a migration that fails", () => {
  test("names the statement that failed, in one line, and applies nothing", () => {
    const path = production(["CREATE TABLE a (x INTEGER)"]);
    let thrown: unknown;
    try {
      openDb(path, [
        "CREATE TABLE a (x INTEGER)",
        "CREATE TABLE fine (y INTEGER);\n  INSERT INTO\n    missing VALUES (1);",
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(ForgeError.isInstance(thrown)).toBe(true);
    const message = (thrown as ForgeError).message;
    expect(message).toBe(
      'migration 2 failed at "INSERT INTO missing VALUES (1)": no such table: missing',
    );
    const db = openDb(path, ["CREATE TABLE a (x INTEGER)"]);
    expect(has(db, "fine")).toBe(false);
    db.close();
  });

  test("the deploy's summary is that line", async () => {
    const path = production(["CREATE TABLE a (x INTEGER)"]);
    const script = join(root, "boot.ts");
    await Bun.write(
      script,
      `import { openDb } from ${JSON.stringify(join(import.meta.dir, "../src/kernel/db.ts"))};
openDb(${JSON.stringify(path)}, ["CREATE TABLE a (x INTEGER)", "INSERT INTO missing VALUES (1)"]);`,
    );
    const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stderr).text()) + (await new Response(proc.stdout).text());
    expect(await proc.exited).not.toBe(0);
    const reason = failureReason(output.split("\n"));
    expect(reason).toContain(
      'migration 2 failed at "INSERT INTO missing VALUES (1)": no such table: missing',
    );
  });
});

describe("statements", () => {
  test("split on semicolons outside quotes, comments and trigger bodies", () => {
    expect(
      statements(`
        CREATE TABLE a (x TEXT DEFAULT 'a;b'); -- a comment; with a semicolon
        /* a block; comment */ INSERT INTO a VALUES (";");
        CREATE TRIGGER t AFTER INSERT ON a BEGIN
          DELETE FROM a WHERE x = 'z';
          DELETE FROM a WHERE x = 'y';
        END;
      `),
    ).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT 'a;b')",
      'INSERT INTO a VALUES (";")',
      expect.stringMatching(/^CREATE TRIGGER t[\s\S]*'y';\s+END$/),
    ]);
  });

  test("every forge migration applies on an empty database", () => {
    const db = openDb(":memory:", migrations);
    expect(has(db, "usage")).toBe(true);
    db.close();
  });
});

describe("a migration is a file named by a sortable id (#1837)", () => {
  const source = join(import.meta.dir, "../src/core/migrations");

  /** The forge's migrations directory, copied, with `extra` files beside them. */
  function directory(extra: Record<string, string>): string {
    const dir = join(root, `migrations-${++n}`);
    cpSync(source, dir, { recursive: true });
    for (const [name, sql] of Object.entries(extra))
      writeFileSync(join(dir, name), `export default ${JSON.stringify(sql)};\n`);
    return dir;
  }

  const listIn = (dir: string): string[] => readMigrations(dir).map((m) => m.sql);

  /** Everything a schema is but the record of how it got there. */
  function shape(path: string): unknown[] {
    const db = new Database(path, { readonly: true, strict: true });
    try {
      return db
        .query(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migration' ORDER BY type, name",
        )
        .all();
    } finally {
      db.close();
    }
  }

  const recorded = (path: string): string[] => {
    const db = new Database(path, { readonly: true, strict: true });
    try {
      return db
        .query<{ id: string }, []>("SELECT id FROM schema_migration ORDER BY id")
        .all()
        .map((row) => row.id);
    } finally {
      db.close();
    }
  };

  test("two pulls' migrations land in either order and the schema ends the same", () => {
    // Two builders, each adding one migration at the second they wrote it:
    // a's after b's, so b sorts first whichever lands first.
    const a = { "20261015120000-deploy-note.ts": "CREATE TABLE deploy_note (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '')" };
    const b = { "20261015110000-user-motto.ts": "ALTER TABLE user ADD COLUMN motto TEXT NOT NULL DEFAULT ''; CREATE INDEX user_motto ON user(motto)" };
    const both = listIn(directory({ ...a, ...b }));
    expect(both.length).toBe(migrations.length + 2);

    const aFirst = production(listIn(directory(a)));
    boot(aFirst, both);
    const bFirst = production(listIn(directory(b)));
    boot(bFirst, both);
    const together = production(both);

    expect(shape(aFirst)).toEqual(shape(together));
    expect(shape(bFirst)).toEqual(shape(together));
    expect(recorded(aFirst)).toEqual(recorded(together));
    expect(recorded(bFirst)).toEqual(recorded(together));
    expect(recorded(together).length).toBe(migrations.length + 2);
    const db = openDb(together, both);
    expect(has(db, "deploy_note")).toBe(true);
    db.close();
  });

  test("stamped ids sort after every numbered one, and among themselves by time", () => {
    const names = readMigrations(
      directory({
        "20261015120000-later.ts": "CREATE TABLE later (id TEXT)",
        "20261015110000-earlier.ts": "CREATE TABLE earlier (id TEXT)",
      }),
    ).map((m) => m.name);
    expect(names.slice(-3)).toEqual([
      migrationFiles[migrationFiles.length - 1]!.name,
      "20261015110000-earlier",
      "20261015120000-later",
    ]);
  });

  test("the numbered migrations keep their names, their order and their text", () => {
    const numbered = migrationFiles.slice(0, NUMBERED).map((m) => m.name);
    expect(numbered.map((name) => name.slice(0, 4))).toEqual(
      Array.from({ length: NUMBERED }, (_, i) => String(i + 1).padStart(4, "0")),
    );
    // A digest of every numbered migration's recorded id, in order: what
    // a database already applied is recognised exactly as before the split.
    expect(sha256(migrations.slice(0, NUMBERED).map(migrationId).join("\n"))).toBe(
      "0d6d9f86125ddb1e0929090cd2842bde09fbc804fea4fa202d684dbc75500302",
    );
    // Every one since is stamped: a new numbered file would be the next
    // number two builders fight over.
    for (const m of migrationFiles.slice(NUMBERED)) expect(m.name).toMatch(/^\d{14}-/);
  });

  test("a file that is not a migration is refused, never skipped", () => {
    for (const [name, body] of [
      ["0089-next.sql", "export default 'CREATE TABLE x (id TEXT)';\n"],
      ["2026-10-15-dated.ts", "export default 'CREATE TABLE x (id TEXT)';\n"],
      ["20261015120000-Upper.ts", "export default 'CREATE TABLE x (id TEXT)';\n"],
      ["20261015120000-no-sql.ts", "export default 42;\n"],
    ] as const) {
      const dir = join(root, `refused-${++n}`);
      mkdirSync(dir);
      writeFileSync(join(dir, name), body);
      expect(() => readMigrations(dir)).toThrow(ForgeError);
    }
  });
});
