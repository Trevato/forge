/**
 * `bun scripts/pin-migrations.ts`: pin every migration in
 * `src/core/migrations/` that `src/core/migration-pins.json` does not
 * name yet, by its id (`migrationId`). An existing pin is never rewritten:
 * once pinned, a migration's text is history, and
 * `test/schema-migrations.test.ts` fails if it changes (#783).
 *
 * The release agent runs it, never a pull, so two pulls adding a
 * migration each never meet in the file. The release record itself is a
 * tag and moves no branch (`scripts/cut-release.ts`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFiles } from "../src/core/schema.ts";
import { type MigrationPins, pinBreaks, pinned } from "../src/kernel/migrate.ts";

const file = join(import.meta.dir, "../src/core/migration-pins.json");
const pins = JSON.parse(readFileSync(file, "utf8")) as MigrationPins;
const breaks = pinBreaks(migrationFiles, pins);
if (breaks.length > 0) {
  for (const line of breaks) console.error(`pin-migrations: ${line}`);
  process.exit(1);
}
const next = pinned(migrationFiles, pins);
const added = Object.keys(next).filter((name) => !(name in pins));
writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
// CLI answer for the person at the terminal.
console.log(
  added.length === 0
    ? "pin-migrations: every migration is already pinned"
    : `pin-migrations: pinned ${added.join(", ")}`,
);
