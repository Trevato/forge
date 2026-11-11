/**
 * Whether an app page shows only its progress (#10299): the app is new and has
 * not run (`apps/onboarding.ts` has a line for it) and nothing was ever
 * shipped or taken as a run. Anything else is an app with something to show.
 */

import type { Database } from "bun:sqlite";
import { mergedPullCount } from "../../core/pulls.ts";
import { agentRunTotals } from "../../core/runs.ts";

/** The start of history, for an "ever" count rather than one week of it. */
const EPOCH = new Date(0).toISOString();

/** Whether anything was ever shipped here, or (for a viewer who sees them) a run taken. */
export function hasHistory(db: Database, repoId: string, ownerFacts: boolean): boolean {
  if (mergedPullCount(db, repoId, EPOCH) > 0) return true;
  return ownerFacts && agentRunTotals(db, repoId, EPOCH).runs > 0;
}
