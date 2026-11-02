/**
 * Choosing a pillar for an issue let out from behind the Later gate (#8924).
 * The gate edge was also what a person's link meant: take it away and an
 * issue a reader opened is nobody's again (`unadoptedAmong`), and one that
 * serves no pillar says nothing about what it is for. So a lift, by hand or
 * by the pacer, leaves the issue under a pillar: the one it already serves,
 * else the first, whose umbrella then waits for it, linked by whoever lifted.
 */

import type { Database } from "bun:sqlite";
import { addDependency } from "./dependencies.ts";
import type { Issue } from "./issues.ts";
import { isStructural, LATER, pillarsOf, servedBy } from "./pillars.ts";
import type { Repo } from "./repos.ts";

/**
 * Put `issue` under a pillar unless one already holds it. Returns the
 * pillar's name when it linked, else undefined: it served one, the gate
 * still held it, or the repository has no pillars to serve.
 */
export function servePillar(db: Database, repo: Repo, issue: Issue, actorId: string): string | undefined {
  const set = pillarsOf(db, repo);
  const pillar = set.pillars[0];
  if (pillar === undefined || issue.kind !== "issue" || isStructural(set, issue.id)) return undefined;
  const serves = servedBy(db, set).get(issue.id);
  // `Later` is the gate or the Later umbrella: neither is a pillar.
  if (serves !== undefined && serves !== LATER) return undefined;
  const linked = addDependency(db, pillar.umbrella, issue, actorId);
  return linked.ok ? pillar.name : undefined;
}
