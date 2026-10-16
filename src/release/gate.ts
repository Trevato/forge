/**
 * Who may see the kept releases and roll back to one, and the one rollback
 * both clients (the /releases page and the SSH terminal) run: the same
 * refusals, `beginSwap`/`endSwap`, the health-read swap, then this process
 * drains. Plain data in, plain data out; neither client re-states a rule.
 */

import { existsSync } from "node:fs";
import type { App } from "../app.ts";
import { canRead, canWrite, getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { releaseDir } from "./checkout.ts";
import type { Release } from "./record.ts";
import { liveSchema, releaseSchema, rollback } from "./rollback.ts";
import { beginSwap, endSwap, handover } from "./swap.ts";

/** When this process began serving: "healthy since" for the release it runs. */
export const BOOTED = new Date().toISOString();

/** The forge's own code repository, when this forge names one. */
function forgeRepoOf(app: App): Repo | undefined {
  const named = app.config.forgeRepo;
  if (named === undefined) return undefined;
  const [owner, name] = named.split("/");
  return owner === undefined || name === undefined ? undefined : getRepo(app.db, owner, name);
}

/** Who may see the release history: the forge repository's readers and a site admin. */
export function mayRead(app: App, user: User | undefined): boolean {
  if (user === undefined) return false;
  if (user.isAdmin) return true;
  const repo = forgeRepoOf(app);
  return repo !== undefined && canRead(app.db, repo, user);
}

export function mayRollBack(app: App, user: User | undefined): boolean {
  // Undoing a deployment is a person's decision, as a revert is (#1824).
  if (user === undefined || user.kind === "agent") return false;
  const repo = forgeRepoOf(app);
  return repo !== undefined && canWrite(app.db, repo, user);
}

/** Is this kept release one the live database can be rolled back to? */
export async function canRollBackTo(app: App, r: Release): Promise<boolean> {
  const dataDir = app.config.dataDir;
  const dir = releaseDir(dataDir, r.sha);
  if (!r.ok || !/^[0-9a-f]{40}$/.test(r.sha) || !existsSync(dir)) return false;
  const known = await releaseSchema(dir);
  return known !== undefined && known >= liveSchema(dataDir);
}

export type RolledBack = { ok: true } | { ok: false; line: string };

/** Swap back to a kept release and drain this process; the caller has checked `mayRollBack`. */
export async function rollBackTo(app: App, user: User, target: string): Promise<RolledBack> {
  const drain = handover.drain;
  const port = app.config.port ?? 0;
  if (app.config.selfSwap !== true || drain === undefined || port <= 0)
    return { ok: false, line: "This forge does not swap releases itself (FORGE_SELF_SWAP is off)." };
  const turn = beginSwap();
  if (!turn.ok) return { ok: false, line: `Not rolled back: ${turn.line}.` };
  const result = await rollback({ dataDir: app.config.dataDir, sha: target, port, env: process.env });
  endSwap(result.ok);
  if (!result.ok) return { ok: false, line: `Not rolled back: ${result.line}.` };
  app.log.info("rolled back; draining this process", { sha: target.slice(0, 12), by: user.username });
  drain();
  return { ok: true };
}
