/**
 * What a wave's "Moved" list needs from the plan that the page and the
 * terminal share: where a milestone lives and how to read the plan for it.
 */
import type { Database } from "bun:sqlite";
import { readPlan, type Plan } from "../core/milestones.ts";
import type { Repo } from "../core/repos.ts";

/** Where a milestone is: its own page, under the repository's base path. */
export const milestonePath = (base: string, number: number): string =>
  `${base}/milestones/${number}`;

/** The repository's plan, read once, for a door with no cache of its own. */
export const planNow = (db: Database, repo: Repo, now: Date): Plan =>
  readPlan(db, repo, { spend: false, now });
