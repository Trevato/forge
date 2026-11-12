/**
 * The head-comparison probe (#9561): one door that re-reads every link a
 * repository follows — its upstream, its sources, its origin — so the flows
 * view shows a fresh health for each. The clock already runs the same reads
 * (`checkDue`, `runAheadReads`); this is the same read, on a person's ask.
 * Admin only, never an agent, one at a time per repository, a few a minute.
 */

import { checkSource, checkUpstream } from "../actions/upstream_follow.ts";
import type { App } from "../app.ts";
import { getFollow } from "../core/upstream_follow.ts";
import { listSources, type FollowSource } from "../core/follow_sources.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { readAhead } from "../origins/ahead.ts";
import { mayStartRadar } from "./start.ts";

export type Probed = { ok: true; read: number } | { ok: false; why: string };

/** The reads one probe makes; tests stand in for the network. */
export interface Reads {
  readonly origin: (app: App, repo: Repo) => Promise<boolean>;
  readonly upstream: (app: App, repo: Repo) => Promise<boolean>;
  readonly source: (app: App, repo: Repo, source: FollowSource) => Promise<boolean>;
}

const realReads: Reads = {
  origin: async (app, repo) => (await readAhead(app, repo)) !== undefined,
  upstream: async (app, repo) => (await checkUpstream(app, repo)).ok,
  source: async (app, repo, source) => (await checkSource(app, repo, source)).ok,
};

/** Sources compared in one probe, how many at once, and the total time, as the radar's run is held. */
export const MAX_SOURCES = 8;
export const LANES = 4;
export const DEADLINE_MS = 30_000;

const running = new Set<string>();
const defaultLimiter = new RateLimiter({ perMinute: 4, adminPerMinute: 4, enabled: true });

export async function probeLinks(
  app: App,
  repo: Repo,
  user: User | undefined,
  limiter: RateLimiter = defaultLimiter,
  reads: Reads = realReads,
  deadlineMs = DEADLINE_MS,
): Promise<Probed> {
  if (!mayStartRadar(app, repo, user)) return { ok: false, why: "Only an admin of this repository can do this." };
  if (running.has(repo.id)) return { ok: false, why: "A comparison is already running for this repository." };
  const verdict = limiter.take(`flows-probe:${user.id}`, "rw");
  if (!verdict.allowed) return { ok: false, why: `Too many comparisons: try again in ${verdict.retryAfter}s.` };
  running.add(repo.id);
  try {
    const stopAt = Date.now() + deadlineMs;
    let read = 0;
    const jobs: (() => Promise<boolean>)[] = [];
    if (repo.origin !== null) jobs.push(() => reads.origin(app, repo));
    else {
      if (getFollow(app.db, repo.id)?.enabled === true) jobs.push(() => reads.upstream(app, repo));
      for (const s of listSources(app.db, repo.id).filter((x) => x.enabled).slice(0, MAX_SOURCES))
        jobs.push(() => reads.source(app, repo, s));
    }
    // A few at a time; none starts once the deadline has passed, and a read still running
    // at the deadline is left to its own timeout while the probe answers.
    const lanes = Array.from({ length: Math.min(LANES, jobs.length) }, async () => {
      for (let job = jobs.shift(); job !== undefined && Date.now() < stopAt; job = jobs.shift()) {
        try {
          if (await job()) read++;
        } catch (error) {
          app.log.warn("link probe failed", { repo: repo.id, error: String(error) });
        }
      }
    });
    await Promise.race([Promise.all(lanes), Bun.sleep(deadlineMs)]);
    app.bus.append({ kind: "repo.links_probed", repoId: repo.id, payload: {} });
    return { ok: true, read };
  } finally {
    running.delete(repo.id);
  }
}
