/**
 * `bun scripts/pin-migrations.ts`: pin every migration in
 * `src/core/migrations/` that is not pinned yet, as its own file
 * `src/core/migration-pins/<name>.pin` holding its id (`migrationId`).
 * An existing pin is never rewritten: once pinned, a migration's text is
 * history, and `test/schema-migrations.test.ts` fails if it changes (#783).
 *
 * The pull that adds a migration runs this and commits the pin beside it.
 * One file per migration means parallel pulls never meet in a shared file,
 * and nothing commits to main at release time (#6646). The release record
 * itself is a tag and moves no branch (`scripts/cut-release.ts`).
 * `src/core/migration-pins.json` is the frozen pins from before.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFiles } from "../src/core/schema.ts";
import {
  type MigrationPins,
  migrationId,
  pinBreaks,
  readPins,
} from "../src/kernel/migrate.ts";

const core = join(import.meta.dir, "../src/core");
const legacy = JSON.parse(readFileSync(join(core, "migration-pins.json"), "utf8")) as MigrationPins;
const dir = join(core, "migration-pins");
const pins = readPins(dir, legacy);
const breaks = pinBreaks(migrationFiles, pins);
if (breaks.length > 0) {
  for (const line of breaks) console.error(`pin-migrations: ${line}`);
  process.exit(1);
}
const added = migrationFiles.filter((m) => !(m.name in pins));
for (const m of added) writeFileSync(join(dir, `${m.name}.pin`), `${migrationId(m.sql)}\n`);
// CLI answer for the person at the terminal.
console.log(
  added.length === 0
    ? "pin-migrations: every migration is already pinned"
    : `pin-migrations: pinned ${added.map((m) => m.name).join(", ")}`,
);
