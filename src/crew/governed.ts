/**
 * The governor wired into the picker (#6375): the slots a repository may
 * fill are the smaller of the spend pacing's and `governedSlots`' (#6374).
 * When the governed number changes, one `crew.governed` event says so, which
 * the feed shows once per change; the tick line carries the reason while
 * the governor holds the crew below the operator's slots.
 */

import type { App } from "../app.ts";
import { canSeeOwnerFacts, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { readRepoFlow } from "../flow/repo_flow.ts";
import { governorSays, readLast, rememberGovernor } from "./governor_log.ts";
import { governedSlots, type Governed } from "./governor.ts";

/** The governor's reading of this repository's own flow, against the operator's slots (#7644). */
export function governorFor(app: App, repo: Repo, now: Date): Governed {
  return governedSlots(readRepoFlow(app.db, repo.id, now), repo.autonomySlots);
}

/** The governor as one reader sees it: its slots, the operator's ceiling, and the reason. */
export interface GovernorSeen extends Governed {
  readonly ceiling: number;
  /** True while the governor holds the crew below the operator's slots. */
  readonly held: boolean;
  /** What the governor last did, in one line (#11459); empty until it has changed the slots. */
  readonly says: string;
}

/**
 * The governor for every door — the studio's two crew cards, the terminal's
 * repository row and MCP `crew` (#7644) — gated and worded alike: undefined
 * while the crew is off, or for a reader who may not see the owner's facts.
 */
export function governorSeen(app: App, actor: User | undefined, repo: Repo, now: Date): GovernorSeen | undefined {
  if (repo.autonomy === "off" || !canSeeOwnerFacts(app.db, repo, actor)) return undefined;
  const g = governorFor(app, repo, now);
  return { ...g, ceiling: repo.autonomySlots, held: g.slots < repo.autonomySlots, says: governorSays(readLast(app.db, repo.id)) };
}

/**
 * The governor in one line for every door (#11459): what it last did while the
 * crew is held (that line carries the reason), else the current reason, with
 * "back to N" followed by the reason it now gives.
 */
export function governorLine(g: GovernorSeen): string {
  if (g.says === "") return g.why;
  return g.held ? g.says : `${g.says}. ${g.why}`;
}

/** The governed number each repository was last seen at; unseen means the operator's slots. */
const seen = new Map<string, number>();

/**
 * Says a change of the governed number, once: the event is appended only
 * when the number differs from the last tick's. Returns the reason while the
 * governor holds the crew below the operator's slots, else undefined.
 */
export function announceGovernor(app: App, repo: Repo, now: Date): string | undefined {
  const g = governorFor(app, repo, now);
  rememberGovernor(app.db, repo.id, g, now.getTime());
  const before = seen.get(repo.id) ?? repo.autonomySlots;
  seen.set(repo.id, g.slots);
  if (g.slots !== before)
    app.bus.append({
      kind: "crew.governed",
      repoId: repo.id,
      payload: { from: before, to: g.slots, why: g.why },
    });
  return g.slots < repo.autonomySlots ? g.why : undefined;
}
