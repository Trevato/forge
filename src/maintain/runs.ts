/** `maintenance_run`: the record of each duty's runs. */

import type { Database } from "bun:sqlite";
import type { Finding } from "./duty.ts";

export interface RunRow {
  readonly id: number;
  readonly duty: string;
  readonly started: string;
  readonly finished: string;
  readonly findings: readonly unknown[];
  readonly actions: readonly string[];
  readonly probes: readonly unknown[];
  readonly outcome: string;
}

export function record(
  db: Database,
  r: { duty: string; started: Date; finished: Date; findings: readonly Finding[]; actions: readonly string[]; outcome: string },
): void {
  db.query(
    "INSERT INTO maintenance_run (duty, started, finished, findings, actions, probes, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).run(
    r.duty,
    r.started.toISOString(),
    r.finished.toISOString(),
    JSON.stringify(r.findings.map((f) => f.summary)),
    JSON.stringify(r.actions),
    JSON.stringify(r.findings.flatMap((f) => (f.probe ? [f.probe] : []))),
    r.outcome,
  );
}

/** Keep a duty's newest `keep` rows; the rest go. */
export function prune(db: Database, duty: string, keep: number): void {
  db.query("DELETE FROM maintenance_run WHERE duty = ?1 AND id NOT IN (SELECT id FROM maintenance_run WHERE duty = ?1 ORDER BY id DESC LIMIT ?2)").run(duty, keep);
}

export function lastStarted(db: Database, duty: string): number | undefined {
  const row = db.query("SELECT started FROM maintenance_run WHERE duty = ?1 ORDER BY id DESC LIMIT 1").get(duty) as
    | { started: string }
    | null;
  return row ? Date.parse(row.started) : undefined;
}

export const LIST_MAX = 100;

export function latest(db: Database, limit: number): RunRow[] {
  const rows = db.query("SELECT * FROM maintenance_run ORDER BY id DESC LIMIT ?1").all(Math.min(Math.max(1, limit), LIST_MAX)) as {
    id: number; duty: string; started: string; finished: string; findings: string; actions: string; probes: string; outcome: string;
  }[];
  return rows.map((r) => ({
    ...r,
    findings: JSON.parse(r.findings) as unknown[],
    actions: JSON.parse(r.actions) as string[],
    probes: JSON.parse(r.probes) as unknown[],
  }));
}
