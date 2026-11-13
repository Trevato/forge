/**
 * The drills, kept: every run of `runDrill` is a row, so the Backups page
 * can say when the forge last proved a snapshot restores, and what failed
 * when it did not. Plain data in, plain data out.
 */

import type { Database } from "bun:sqlite";
import type { DrillResult, DrillStep, PhaseTime } from "./drill.ts";

interface Row {
  at: string;
  snapshot_id: string | null;
  ms: number;
  repositories: number;
  issues: number;
  users: number;
  pulls: number;
  apps: number;
  verdict: "green" | "red";
  failed_step: DrillStep | null;
  reason: string | null;
  phases: string | null;
}

const PHASES = new Set(["manifest", "files", "unpack", "bundles", "key", "open", "boot"]);

/** Where a kept drill restored from; empty when it was kept before that was recorded, or the JSON is not ours. */
export function parseFrom(raw: string | null): { from?: string; offSite?: boolean } {
  try {
    const v = JSON.parse(raw ?? "null") as { from?: unknown; offSite?: unknown } | null;
    if (typeof v?.from !== "string" || v.from.length > 300) return {};
    return { from: v.from, offSite: v.offSite === true };
  } catch {
    return {};
  }
}

/** The stored JSON as phases; anything that is not a list of known phases with whole ms reads as none. */
export function parsePhases(raw: string | null): { phases: PhaseTime[]; budgetMs: number } {
  const none = { phases: [], budgetMs: 0 };
  if (raw === null) return none;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return none;
    const { phases, budgetMs } = v as { phases?: unknown; budgetMs?: unknown };
    if (!Array.isArray(phases) || typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs < 0) return none;
    const out: PhaseTime[] = [];
    for (const p of phases) {
      const { phase, ms } = (p ?? {}) as { phase?: unknown; ms?: unknown };
      if (typeof phase !== "string" || !PHASES.has(phase) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return none;
      out.push({ phase: phase as PhaseTime["phase"], ms });
    }
    return { phases: out, budgetMs };
  } catch {
    return none;
  }
}

export function recordDrill(db: Database, result: DrillResult): void {
  db.query(
    `INSERT INTO drill (at, snapshot_id, ms, repositories, issues, users, pulls, apps, verdict, failed_step, reason, phases)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.at,
    result.snapshotId,
    result.ms,
    result.counts.repositories,
    result.counts.issues,
    result.counts.users,
    result.counts.pulls,
    result.counts.apps,
    result.verdict,
    result.failedStep,
    result.reason,
    // Where it restored from rides the same column: no migration for two plain fields (#11805).
    JSON.stringify({
      phases: result.phases,
      budgetMs: result.budgetMs,
      ...(result.from === undefined ? {} : { from: result.from, offSite: result.offSite === true }),
    }),
  );
}

/** The newest drill, or undefined when none has run. */
export function lastDrill(db: Database): DrillResult | undefined {
  const row = db
    .query<Row, []>("SELECT * FROM drill ORDER BY id DESC LIMIT 1")
    .get();
  if (row === null) return undefined;
  const kept = parsePhases(row.phases);
  return {
    at: row.at,
    snapshotId: row.snapshot_id,
    ms: row.ms,
    counts: {
      repositories: row.repositories,
      issues: row.issues,
      users: row.users,
      pulls: row.pulls,
      apps: row.apps,
    },
    // Not stored: green means health read ok; a red one failed at it or never got there.
    health:
      row.verdict === "green" ? "ok" : row.failed_step === "health" ? "failed" : "unreached",
    verdict: row.verdict,
    failedStep: row.failed_step,
    reason: row.reason,
    phases: kept.phases,
    budgetMs: kept.budgetMs,
    ...parseFrom(row.phases),
  };
}
