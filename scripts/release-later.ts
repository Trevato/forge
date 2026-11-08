/**
 * `bun scripts/release-later.ts <dataDir> <owner/repo> [--only 7636,7637] [--apply]`
 * (#7801): list the open issues the Later gate holds alone, and with
 * `--apply` unlink them from it. Without `--apply` it writes nothing.
 * Owner-run, against the data directory of a stopped or running forge
 * (sqlite WAL; read-only without `--apply`, and `--apply` releases all or
 * none in one transaction); afterwards the list is empty, and that is the confirmation.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { heldByGateAlone, releaseFromGate } from "../src/crew/release_later.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.indexOf(name);
const only = flag("--only") >= 0 ? (args[flag("--only") + 1] ?? "") : undefined;
const apply = flag("--apply") >= 0;
const [dataDir, slug] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
const [owner, name] = (slug ?? "").split("/");
if (!dataDir || !owner || !name || (only !== undefined && !/^\d+(,\d+)*$/.test(only))) {
  console.error("usage: bun scripts/release-later.ts <dataDir> <owner/repo> [--only 7636,7637] [--apply]");
  process.exit(2);
}

const dbPath = join(dataDir, "forge.db");
if (!existsSync(dbPath)) {
  console.error(`release-later: no forge.db in ${dataDir}`);
  process.exit(2);
}
// A running forge holds this WAL database: list mode opens it read-only, and a
// write waits up to 5 s for the forge's lock rather than failing SQLITE_BUSY.
const db = new Database(dbPath, apply ? { readwrite: true } : { readonly: true });
db.run("PRAGMA busy_timeout = 5000");
const hasSchema = db
  .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('repo', 'user', 'issue', 'issue_dependency')")
  .get()?.n === 4;
if (!hasSchema) {
  console.error(`release-later: ${dbPath} is not a forge database (the forge's tables are missing)`);
  process.exit(2);
}
const repo = db
  .query<{ id: string }, [string, string]>(
    "SELECT r.id FROM repo r JOIN user u ON u.id = r.owner_id WHERE u.username = ?1 AND r.name = ?2",
  )
  .get(owner, name);
if (!repo) {
  console.error(`release-later: no repository ${slug}`);
  process.exit(2);
}
const picked = only === undefined ? undefined : new Set(only.split(",").map(Number));
const held = heldByGateAlone(db, repo.id).filter((h) => picked === undefined || picked.has(h.number));
for (const h of held) console.log(`#${h.number}\tlinked by ${h.linkedBy}\t${h.title}`);
console.log(`release-later: ${held.length} held by the Later gate alone`);
if (apply) {
  const done = releaseFromGate(db, repo.id, held.map((h) => h.number));
  console.log(`release-later: released ${done.length}`);
}
db.close();
