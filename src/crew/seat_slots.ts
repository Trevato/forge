/**
 * The three pillars — plan, build, review — each with how much it may do at
 * once and what it is doing and spending now (#7668). One place says it: the
 * team card draws it and the MCP `crew` tool returns it, so a page and an
 * agent read the same facts. A pillar set to 0 is paused: its agent stays on
 * the crew, and it starts nothing until the number goes up again.
 */

import type { Database } from "bun:sqlite";
import { isCrewRole, type CrewRole } from "../core/agents.ts";
import { PILLAR_MAX, type Repo } from "../core/repos.ts";
import { startOfTodayUtc } from "./autonomy.ts";

export type SeatSlots = {
  role: CrewRole;
  /** What it may do at once; 0 is paused. */
  slots: number;
  /** The most `slots` can be set to. */
  max: number;
  /** Runs working now. */
  running: number;
  /** Runs queued, not yet started. */
  waiting: number;
  /** Dollars spent by this pillar since UTC midnight. */
  spentUsd: number;
  /** Its share of today's spend here, in whole percent; 0 when nothing was spent. */
  sharePct: number;
};

export const PILLAR_ROLES: readonly CrewRole[] = ["planner", "builder", "reviewer"];

/** What a pillar's number counts, as a clause after "may"; one place so a page and the MCP agree. */
export const SEAT_UNIT: Record<CrewRole, string> = {
  planner: "planning pass at once",
  builder: "build at once",
  reviewer: "review at once",
  maintainer: "upkeep pass at once",
};

export function slotsOf(repo: Repo, role: CrewRole): number {
  return role === "planner" ? repo.plannerSlots : role === "reviewer" ? repo.reviewerSlots : repo.autonomySlots;
}

export function maxOf(role: CrewRole): number {
  return role === "planner" ? 1 : PILLAR_MAX;
}

/** A pillar's slots as a person or an agent typed them: a whole number from 0 to its most, or undefined. */
export function checkSeatSlots(role: string, raw: unknown): { role: CrewRole; slots: number } | undefined {
  if (!isCrewRole(role) || !PILLAR_ROLES.includes(role)) return undefined;
  const n = typeof raw === "string" && /^\d{1,2}$/.test(raw.trim()) ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= maxOf(role) ? { role, slots: n } : undefined;
}

/** The pillars as `repo` has them now. */
export function seatSlotsOf(db: Database, repo: Repo, now = new Date()): SeatSlots[] {
  const since = startOfTodayUtc(now).toISOString();
  // A run belongs to the pillar its agent holds on this crew; one by nobody is a builder's.
  const rows = db
    .query<{ role: string; running: number; waiting: number; spent: number }, [string, string]>(
      `SELECT COALESCE(repo_crew.role, 'builder') AS role,
              SUM(run.state = 'running') AS running,
              SUM(run.state = 'queued') AS waiting,
              SUM(CASE WHEN run.created_at >= ?2 THEN run.cost_usd ELSE 0 END) AS spent
         FROM run LEFT JOIN repo_crew
           ON repo_crew.repo_id = run.repo_id AND repo_crew.user_id = run.actor_id
        WHERE run.repo_id = ?1 AND run.kind = 'agent'
          AND (run.state IN ('queued','running') OR run.created_at >= ?2)
        GROUP BY 1`,
    )
    .all(repo.id, since);
  const by = new Map(rows.map((r) => [r.role, r]));
  const total = rows.reduce((sum, r) => sum + r.spent, 0);
  return PILLAR_ROLES.map((role) => {
    const r = by.get(role);
    const spentUsd = r?.spent ?? 0;
    return {
      role,
      slots: slotsOf(repo, role),
      max: maxOf(role),
      running: r?.running ?? 0,
      waiting: r?.waiting ?? 0,
      spentUsd,
      sharePct: total > 0 ? Math.round((spentUsd / total) * 100) : 0,
    };
  });
}

/** One plain line on a pillar's state, the same words on the page and over the MCP. */
export function seatSlotsWords(p: SeatSlots): string {
  const doing =
    p.slots === 0
      ? "Paused."
      : p.running === 0 && p.waiting === 0
        ? "Idle."
        : `${String(p.running)} running${p.waiting > 0 ? `, ${String(p.waiting)} waiting` : ""}.`;
  return `${doing} ${p.spentUsd > 0 ? `$${p.spentUsd.toFixed(2)} today, ${String(p.sharePct)}% of the spend.` : "Nothing spent today."}`;
}
