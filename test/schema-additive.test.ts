/**
 * Every migration a roll can meet is additive (#875): the old process keeps
 * serving on the database the new one migrates, so a migration newer than
 * the releases still in play never drops, renames or rebuilds what they
 * read, and never adds a NOT NULL column they would not fill.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import releases from "../src/core/releases-before-tags.json" with { type: "json" };
import {
  migrationFiles,
  migrations,
  NUMBERED,
} from "../src/core/schema.ts";
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

  test("every migration not in both releases still in play is additive", () => {
    const inPlay = record.releases.slice(0, 2).map(shipped);
    expect(inPlay.length).toBeGreaterThan(0);
    const offenders = migrationFiles
      .filter((m) => inPlay.some((ids) => !ids.has(m.name)))
      .filter((m) => !(m.name in RETIRED) && !(m.name in REBUILT))
      .map((m) => ({ name: m.name, problems: notAdditive(m.sql) }))
      .filter((m) => m.problems.length > 0);
    expect(offenders).toEqual([]);
  });

  test("a retired drop removes only what no file in src still names", () => {
    // The release that stopped reading a table or column has rolled out
    // (each entry says which); what keeps it true is that nothing since
    // names the dropped thing again, outside the migrations that made it.
    const named: string[] = [];
    for (const path of new Glob("**/*.ts").scanSync(src)) {
      if (path.startsWith("core/migrations/")) continue;
      const text = readFileSync(join(src, path), "utf8");
      for (const [migration, { drops }] of Object.entries(RETIRED))
        for (const name of drops)
          // `name.` is an event kind (`flow_only.cleared`), not the schema.
          if (new RegExp(`\\b${name}\\b(?!\\.)`).test(text)) named.push(`${path} names ${name} (${migration})`);
    }
    expect(named).toEqual([]);
    for (const [migration, { drops }] of Object.entries(RETIRED)) {
      const file = migrationFiles.find((m) => m.name === migration);
      expect(file).toBeDefined();
      for (const name of drops) expect(file!.sql).toContain(name);
    }
  });

  test("a release cut moves no branch: its record is a tag, not a file in the tree", () => {
    // The releases before #6642 stay frozen beside the code; one cut since
    // lives on its tag (release/shipped.ts). A check runs on the tree
    // alone, so it reads the frozen list: a migration landed since is held
    // to additive, as it was when it landed.
    expect(existsSync(join(import.meta.dir, "../src/core/releases.json"))).toBe(false);
  });

  test("the release record is newest first and never ahead of the schema", () => {
    const counts = record.releases.map((r) => r.migrations);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    const names = new Set(migrationFiles.map((m) => m.name));
    for (const r of record.releases) {
      expect(r.migrations).toBeLessThanOrEqual(migrations.length);
      if (r.ids === undefined) {
        expect(r.migrations).toBeLessThanOrEqual(NUMBERED);
        continue;
      }
      // The count is the ids applied: every numbered one and the stamped
      // ones it names, each a file this schema has.
      expect(r.migrations).toBe(NUMBERED + r.ids.length);
      for (const id of r.ids) {
        expect(id).not.toMatch(/^\d{4}-/);
        expect(names.has(id)).toBe(true);
      }
    }
  });

  test("which migrations a release shipped is read by id, not by position", () => {
    // A stamped migration written before another but landing after it
    // sorts first; the release that shipped only the later one still names
    // exactly that one, so the earlier one is the one held to additive.
    const numbered = migrationFiles.slice(0, NUMBERED).map((m) => m.name);
    const ids = shipped({ migrations: NUMBERED + 1, ids: ["20261016000000-b"] });
    expect(ids.size).toBe(NUMBERED + 1);
    for (const name of numbered) expect(ids.has(name)).toBe(true);
    expect(ids.has("20261016000000-b")).toBe(true);
    expect(ids.has("20261015000000-a")).toBe(false);
    expect(shipped({ migrations: 2 })).toEqual(new Set(numbered.slice(0, 2)));
  });
});

/**
 * Migrations that drop on purpose, each after the release that stopped
 * reading what it drops has rolled out: the migration, the names it drops,
 * and where the readers left.
 */
const RETIRED: Record<string, { readonly drops: readonly string[]; readonly since: string }> = {
  "20261103100000-drop-flow-only": {
    drops: ["flow_only_watch", "flow_only"],
    since: "d34910d4 (#7771), shipped from v0.7.302 (#8731)",
  },
};

/**
 * Migrations that rebuild a table under its own name, in one transaction, with
 * every column the old release reads kept and only columns added: an old
 * process sees the same table before and after. SQLite cannot drop a UNIQUE
 * constraint in place, so a rebuild is the only way to lift one.
 */
const REBUILT: Record<string, string> = {
  "20261103120000-conversations-many": "conversation loses UNIQUE(user_id) (#8814); same columns, plus title and archived_at",
  "20261104100000-conversation-run-stopped-state": "conversation_run widens its state CHECK to admit stopped (#8972); same columns, same rows, the stopped column kept",
  "20261114000000-estimate-done": "issue_estimate widens its event CHECK to admit done (#11955); same columns, same rows, the indexes made again; the release before never writes or reads a done row",
  "20261110170000-fork-follow-dont-follow": "fork_follow widens its mode CHECK to admit dont-follow (#608); same columns, same rows; the release before reads dont-follow as not take-updates",
};

const src = join(import.meta.dir, "../src");

interface Release {
  readonly migrations: number;
  readonly ids?: readonly string[];
}

const record: { readonly releases: readonly Release[] } = releases;

/** The migration ids a release applied, by name. */
function shipped(release: Release): Set<string> {
  return new Set([
    ...migrationFiles
      .slice(0, Math.min(release.migrations, NUMBERED))
      .map((m) => m.name),
    ...(release.ids ?? []),
  ]);
}
