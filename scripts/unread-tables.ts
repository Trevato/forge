/**
 * Unread tables (#11843): each table a migration creates that no code under
 * `src/` reads. A record the forge writes and nobody can read back is not done
 * (docs/VISION.md: done means reachable); reviewers asked for "make the record
 * reachable" four times (#9975, #10663, #10664, #11735). Read means the table
 * follows `FROM` or `JOIN` in a `src/` file other than a migration, in any
 * quoting. A table a later migration drops is not counted.
 * `scripts/unread-tables-allow.json` is what main carries today;
 * `test/unread-tables.test.ts` keeps it shrinking.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CREATE = /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)["`]?/gi;
const DROP = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)["`]?/gi;
const RENAME = /\bALTER\s+TABLE\s+["`]?([a-z_][a-z0-9_]*)["`]?\s+RENAME\s+TO\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi;

const scan = (root: string, glob: string) => [...new Bun.Glob(glob).scanSync({ cwd: root })].sort();

/** The tables the migrations under `root` create and keep, sorted. */
export function createdTables(root: string): string[] {
  const made = new Set<string>();
  for (const f of scan(root, "src/core/migrations/*.ts")) {
    const text = readFileSync(join(root, f), "utf8");
    for (const m of text.matchAll(CREATE)) made.add(m[1]!.toLowerCase());
    for (const m of text.matchAll(RENAME)) {
      made.delete(m[1]!.toLowerCase());
      made.add(m[2]!.toLowerCase());
    }
    for (const m of text.matchAll(DROP)) made.delete(m[1]!.toLowerCase());
  }
  return [...made].sort();
}

/** The created tables no `src/` file outside migrations reads, sorted. */
export function unreadTables(root: string): string[] {
  const text = scan(root, "src/**/*.ts")
    .filter((f) => !f.startsWith("src/core/migrations/") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
  return createdTables(root).filter(
    (t) => !new RegExp(`\\b(?:FROM|JOIN)\\s+["\`]?${t}\\b`, "i").test(text),
  );
}
