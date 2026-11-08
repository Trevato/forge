/**
 * The whole schema, as migrations: one file each under `migrations/`,
 * applied in the order their names sort. Append-only: released migrations
 * are immutable history, exactly like commits. The database is an index over
 * truth that lives in git wherever possible — small on purpose.
 *
 * A file is named by a sortable id. `0001` to `0091` are the migrations that
 * were numbered while they lived in one list in this file, in that order; a
 * new one is named by the UTC second it was written
 * (`date -u +%Y%m%d%H%M%S`, e.g. `20261015093000-deploy-notes.ts`), so two
 * pulls that each add one add two files and never touch the same line
 * (#1837). Each file is one `export default` of SQL. The database records
 * each applied one by name (#783); `migration-pins/` (one file each, written by the
 * pull that adds it) and `migration-pins.json` (older) hold what each said, and a test fails if one says something else.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { type MigrationFile, readMigrations } from "../kernel/migrate.ts";

export const migrationFiles: readonly MigrationFile[] = readMigrations(
  join(import.meta.dir, "migrations"),
);

export const migrations: readonly string[] = migrationFiles.map((m) => m.sql);

/** How many migrations were numbered in one list before #1837. */
export const NUMBERED = 91;

/**
 * Drop hand-installed "operator's guard" triggers that refused new accounts
 * from creating repositories. The guard is now the `guard_new_accounts`
 * setting (default off, flippable by the forge admin); these legacy
 * triggers would keep refusing with no toggle and no audit trail. Only
 * triggers on the `repo` table whose SQL carries the guard's message are
 * touched — every other trigger stays exactly as it was.
 *
 * Runs on boot, not as a tracked migration: a trigger's name is the
 * operator's choice, so no fixed SQL can name it, and the drop is
 * idempotent — a second boot finds nothing and changes nothing.
 */
export function dropLegacyNewAccountGuards(db: Database): string[] {
  // The operator's emergency guards of 2026-10-05 were a family: triggers
  // named `steward_…` on `repo`, `run` and `repo_crew` that refused anyone
  // outside a hand-kept table of trusted owners ("new accounts cannot
  // create repositories yet", "runs are not enabled for this account yet",
  // "crew is not enabled for this account yet"), a later one that said
  // "paused for new accounts while the forge adds spending and resource
  // limits", and a hold on build checks. The limits they waited for exist
  // (`guard_new_accounts`, ceilings, slots); the guards outlived them and
  // refused the forge's own admin. Every one goes, on any table; nothing
  // the schema itself declares is named `steward_…` or says those words.
  const names = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger'
          AND (name LIKE 'steward\\_%' ESCAPE '\\'
            OR (tbl_name IN ('repo', 'app', 'run', 'repo_crew')
              AND (sql LIKE '%new accounts cannot create repositories%'
                OR sql LIKE '%paused for new accounts%'
                OR sql LIKE '%not enabled for this account yet%')))`,
    )
    .all()
    .map((row) => row.name);
  for (const name of names) {
    // The name comes from the schema itself, but quote it anyway: a
    // hand-installed trigger may be named anything at all.
    db.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
  }
  return names;
}
