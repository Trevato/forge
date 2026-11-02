/**
 * Prints every flow read, one line each: `bun scripts/flow-report.ts [--db <path>] [--public] [--json]`.
 * The database opens read-only; by default it is forge.db under FORGE_DATA.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { flowReadings, flowReportLines } from "../src/flow/report.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const at = args.indexOf("--db");
const known = new Set(["--db", "--public", "--json"]);
const bad = args.find((a, i) => !known.has(a) && args[i - 1] !== "--db");
if (bad !== undefined || (at >= 0 && (!args[at + 1] || args[at + 1]!.startsWith("-")))) {
  console.error("usage: bun scripts/flow-report.ts [--db <path>] [--public] [--json]");
  process.exit(2);
}
const path = at >= 0 ? args[at + 1]! : join(process.env.FORGE_DATA ?? "data", "forge.db");
let db: Database;
try {
  db = new Database(path, { readonly: true });
  db.query("select 1 from sqlite_master limit 1").get();
} catch {
  console.error(`cannot open ${path}: no readable database there`);
  process.exit(1);
}
const readings = flowReadings(db, new Date(), flag("--public"));
console.log(flag("--json") ? JSON.stringify(readings, null, 2) : flowReportLines(readings).join("\n"));
db.close();
