/**
 * Run tokens: the credential a crew run is handed. It is a `rw` token for
 * the crew member, named for the run and expiring with it, but bound to the
 * repository the run works on and the crew member's fork of it the run
 * pushes to: `http/run_gate.ts` lets it reach those two and read the
 * repository's fork parent, and answers every other request `not_found`.
 * A crew member works across repositories; text in one of them (a README,
 * a comment) must not steer a run into another (#3963).
 */

import type { Database } from "bun:sqlite";
import { createToken } from "./tokens.ts";

/** The repositories a run token is bound to. */
export interface RunScope {
  readonly repoId: string;
  readonly forkId: string;
}

export function mintRunToken(
  db: Database,
  userId: string,
  runId: string,
  scope: RunScope,
  expiresAt: string,
): { id: string; token: string } {
  const minted = createToken(db, userId, `run:${runId}`, "rw", { expiresAt });
  db.query(
    "INSERT INTO run_token (token_id, repo_id, fork_id) VALUES (?1, ?2, ?3)",
  ).run(minted.id, scope.repoId, scope.forkId);
  return minted;
}
