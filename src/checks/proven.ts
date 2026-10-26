/**
 * One green result per tree (#1795). A check whose answer is already known
 * to be green is not run again: each run has a key — the repository, the
 * tree it runs on, the gate (command, install, timeout, egress, limits) and,
 * for the fast tier, the base tip and the tests the pull learned — and the
 * first green run to prove a key is remembered. Only green is kept: a red
 * can be the environment's doing and is always asked again.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";

export interface KeyInputs {
  /** A repository never reuses another's verdict, whatever the tree. */
  readonly repoId: string;
  readonly treeOid: string;
  readonly command: string;
  readonly install: string | null;
  readonly timeout: number;
  readonly egress: readonly string[];
  readonly limits: unknown;
  /** The fast tier's base tip and learned tests; absent for the others. */
  readonly base?: string | undefined;
  readonly learned?: string | undefined;
  /** The Bun that runs the tests; the running one when not said. The lockfile is in the tree. */
  readonly bun?: string | undefined;
}

/** The key two runs share exactly when nothing that could change the verdict differs. */
export function checkKey(x: KeyInputs): string {
  return sha256(
    JSON.stringify([
      x.repoId,
      x.treeOid,
      x.command,
      x.install,
      x.timeout,
      [...x.egress].sort(),
      x.limits,
      x.base ?? "",
      x.learned ?? "",
      x.bun ?? Bun.version,
    ]),
  );
}

/** The run (or gate) that first proved this key green, if any. */
export function provenBy(db: Database, key: string): string | undefined {
  return db
    .query<{ proven_by: string }, [string]>(
      "SELECT proven_by FROM check_proven WHERE key = ?1",
    )
    .get(key)?.proven_by;
}

/** Remember a green key; the first prover is kept. */
export function recordProven(db: Database, key: string, by: string): void {
  db.query(
    "INSERT OR IGNORE INTO check_proven (key, proven_by) VALUES (?1, ?2)",
  ).run(key, by);
}
