/**
 * The governor wired into the picker (#6375): the slots a repository may
 * fill are the smaller of the spend pacing's and `governedSlots`' (#6374).
 * When the governed number changes, one `crew.governed` event says so, which
 * the feed shows once per change; the tick line carries the reason while
 * the governor holds the crew below the operator's slots.
 */

import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import { readVitals } from "../flow/vitals.ts";
import { governedSlots, type Governed } from "./governor.ts";

/** The governor's reading of the forge's flow, against the operator's slots. */
export function governorFor(app: App, repo: Repo, now: Date): Governed {
  return governedSlots(readVitals(app.db, now), repo.autonomySlots);
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
