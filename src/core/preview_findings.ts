/**
 * What `webspec()` found on a preview (#2955): one row per deploy run, the
 * findings as JSON. Report-only; nothing here reads or changes a run's state.
 */

import type { Database } from "bun:sqlite";
import { listRuns } from "./runs.ts";
import type { Finding } from "../release/webspec.ts";

export function recordPreviewFindings(db: Database, runId: string, findings: readonly Finding[]): void {
  db.query(
    `INSERT INTO preview_finding (run_id, findings) VALUES (?1, ?2)
     ON CONFLICT(run_id) DO UPDATE SET findings = excluded.findings, at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(runId, JSON.stringify(findings));
}

const text = (v: unknown): v is string => typeof v === "string" && v.length <= 500;

/** A stored finding, or null when it is not one: its section must be an https link. */
function sound(v: unknown): Finding | null {
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  if (!text(f["path"]) || !text(f["check"]) || !text(f["message"]) || !text(f["section"])) return null;
  if (!f["section"].startsWith("https://")) return null;
  return {
    path: f["path"],
    check: f["check"],
    message: f["message"],
    section: f["section"],
    ...(f["edge"] === true ? { edge: true as const } : {}),
  };
}

/** The findings stored for a run, or null when none were ever recorded. */
export function previewFindings(db: Database, runId: string): Finding[] | null {
  const row = db
    .query<{ findings: string }, [string]>("SELECT findings FROM preview_finding WHERE run_id = ?1")
    .get(runId);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.findings);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(sound).filter((f): f is Finding => f !== null);
  } catch {
    return null;
  }
}

/** The findings of a pull's preview: those of its latest deploy run (`env` is `pull-<n>`). */
export function pullPreviewFindings(db: Database, repoId: string, env: string): Finding[] | null {
  const run = listRuns(db, repoId, { kind: "deploy", env, limit: 1 })[0];
  return run === undefined ? null : previewFindings(db, run.id);
}

/** The count, as a sentence: edge-owned findings are counted apart, never as the app's. */
export function findingsWords(found: readonly Finding[]): string {
  const own = found.filter((f) => f.edge !== true).length;
  const edge = found.length - own;
  if (found.length === 0) return "website spec: no findings";
  const mine = `${own} finding${own === 1 ? "" : "s"}`;
  return `website spec: ${mine}${edge > 0 ? `, ${edge} the edge owns` : ""}`;
}
