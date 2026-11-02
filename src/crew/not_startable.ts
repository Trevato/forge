/**
 * Why a ready issue is not startable, one reason each (#8924): what
 * `held.ts` holds (a run, a pull, a cap, a hot file) and what the picker
 * passes over (`pick_filter.ts`: polish's share, the owner's bets, no builder
willing). No ready
 * issue goes unexplained: Next up prints these beside the tick line's counts.
 */

import type { App } from "../app.ts";
import type { Ranked } from "../core/dependencies.ts";
import type { Repo } from "../core/repos.ts";
import { listActive } from "../core/runs.ts";
import { listCrewRoles } from "../core/agents.ts";
import { PASSED_WORDS, pickFilter, routable } from "./pick_filter.ts";
import { admits, heldBy, mapHolds } from "./held.ts";

/** Each ready issue a builder will not start now, by issue id, with its one reason. */
export function notStartable(
  app: App,
  repo: Repo,
  ready: readonly Ranked[],
  scope: { sealed?: true; sealedBy?: string },
): Map<string, string> {
  const active = listActive(app.db, "agent").filter((r) => r.repoId === repo.id);
  const admit = admits(app, repo, scope);
  const crew = listCrewRoles(app.db, repo.id);
  const held = heldBy(app, repo, ready, crew, active, admit);
  const out = new Map<string, string>();
  const { holds } = mapHolds(repo, held, admit);
  for (const { issue } of ready) {
    if (issue.id === repo.directionIssueId) out.set(issue.id, "the planner's standing direction, never a builder's");
    const hold = holds.get(issue.number);
    if (hold !== undefined) out.set(issue.id, hold.detail);
  }
  const now = new Date();
  const routed = routable(app, repo, held.startable, crew, now);
  const { passed } = pickFilter(app, repo, routed.kept, now);
  for (const [id, why] of [...routed.passed, ...passed]) out.set(id, PASSED_WORDS[why]);
  return out;
}
