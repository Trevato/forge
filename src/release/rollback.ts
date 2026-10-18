/**
 * `bun src/main.ts --rollback <sha>`: swap back to a kept release. The same
 * health-read swap as a landing (`startRelease`), after two refusals that
 * each take one line: the release is not kept, or its schema is behind the
 * live database's (a down-migration is not something this forge has).
 * A release whose schema is ahead of the live database is fine: it migrates
 * forward on boot. A release behind it is refused here, not by the
 * database: a build boots on migrations it does not know and only names
 * them (#783).
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { releaseDir } from "./checkout.ts";
import { startRelease, type SwapInput } from "./swap.ts";

export type Rollback = { ok: true; pid: number } | { ok: false; line: string };

/** How many migrations the live database has applied; 0 when there is none yet. */
export function liveSchema(dataDir: string): number {
  const file = join(dataDir, "forge.db");
  if (!existsSync(file)) return 0;
  const db = new Database(file, { readonly: true });
  try {
    const table = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migration'")
      .get();
    if (table?.n === 1)
      return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migration").get()?.n ?? 0;
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  } finally {
    db.close();
  }
}

/** How many migrations the kept release knows, read from its own schema module. */
export async function releaseSchema(dir: string): Promise<number | undefined> {
  const file = join(dir, "src", "core", "schema.ts");
  if (!existsSync(file)) return undefined;
  try {
    const mod = (await import(file)) as { migrations?: readonly unknown[] };
    return Array.isArray(mod.migrations) ? mod.migrations.length : undefined;
  } catch {
    return undefined;
  }
}

export async function rollback(
  input: Omit<SwapInput, "dir" | "sha"> & { dataDir: string; sha: string },
): Promise<Rollback> {
  const { dataDir, sha, ...swap } = input;
  const shown = /^[0-9a-f]{1,40}$/.test(sha) ? sha : "(not a commit id)";
  const dir = releaseDir(dataDir, sha);
  if (!/^[0-9a-f]{40}$/.test(sha) || !existsSync(dir))
    return { ok: false, line: `no kept release ${shown}; it was never checked out or has been pruned` };
  const known = await releaseSchema(dir);
  if (known === undefined) return { ok: false, line: `${sha} has no readable schema; not rolling back to it` };
  const live = liveSchema(dataDir);
  if (known < live)
    return { ok: false, line: `${sha} predates schema ${live}; rolling back would need a down-migration` };
  return startRelease({ ...swap, dir, sha });
}
