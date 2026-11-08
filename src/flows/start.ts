/**
 * Starting the radar (#9434), one door for the page and the terminal: only an
 * admin of the repository (never an agent) may, a repository has one run at a
 * time, and one identity gets a few runs a minute.
 */

import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { npmLookup, type Lookup } from "./radar.ts";
import { runRadar } from "./run.ts";

export type Started = { ok: true; read: number } | { ok: false; why: string };

const running = new Set<string>();
const RUNS_PER_MINUTE = 4;
const defaultLimiter = new RateLimiter({ perMinute: RUNS_PER_MINUTE, adminPerMinute: RUNS_PER_MINUTE, enabled: true });

/** May this person start a run: the same check on every door. */
export const mayStartRadar = (app: App, repo: Repo, user: User | undefined): user is User =>
  user !== undefined && user.kind !== "agent" && canAdmin(app.db, repo, user);

export async function startRadar(
  app: App,
  repo: Repo,
  user: User | undefined,
  lookup: Lookup = npmLookup,
  limiter: RateLimiter = defaultLimiter,
): Promise<Started> {
  if (!mayStartRadar(app, repo, user)) return { ok: false, why: "Only an admin of this repository can do this." };
  if (running.has(repo.id)) return { ok: false, why: "A read is already running for this repository." };
  const verdict = limiter.take(`flows:${user.id}`, "rw");
  if (!verdict.allowed) return { ok: false, why: `Too many reads: try again in ${verdict.retryAfter}s.` };
  running.add(repo.id);
  try {
    return { ok: true, read: await runRadar(app, repo, lookup) };
  } finally {
    running.delete(repo.id);
  }
}
