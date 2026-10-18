/**
 * The victim of the kill fault: a process that writes runs into the world's
 * database and is shot with SIGKILL while it does. `bun worker.ts <db> <repo>`.
 */

import { openDb } from "../kernel/db.ts";
import { migrationFiles } from "../core/schema.ts";
import { claimRun, createRun, heartbeatRuns } from "../core/runs.ts";

const [dbPath, repoId] = process.argv.slice(2);
if (dbPath === undefined || repoId === undefined) process.exit(2);
const db = openDb(dbPath, migrationFiles);
console.log("ready");
for (;;) {
  const run = createRun(db, { repoId, kind: "check" });
  console.log(run.id);
  claimRun(db, run.id);
  heartbeatRuns(db, [run.id]);
}
