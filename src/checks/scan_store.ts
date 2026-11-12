/**
 * Code scanning's findings as rows (#9593): recorded once per fingerprint,
 * listed for the repository's findings page and flows line, and the open
 * high ones that hold a release until a person accepts each with a reason.
 */

import type { Database } from "bun:sqlite";
import type { Finding, ScanKind, Severity } from "./scan_rules.ts";

export interface FindingRow {
  readonly id: number;
  readonly kind: ScanKind;
  readonly severity: Severity;
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly oid: string;
  /** The hash of rule, path and match: how a later read knows it again. Never the match. */
  readonly fingerprint: string;
  readonly foundAt: string;
  /** Who accepted it, by username, with why and when; null while open. */
  readonly accepted: { readonly by: string; readonly reason: string; readonly at: string } | null;
}

interface Raw {
  id: number;
  kind: ScanKind;
  severity: Severity;
  rule: string;
  path: string;
  line: number;
  oid: string;
  fingerprint: string;
  found_at: string;
  accepted_reason: string | null;
  accepted_at: string | null;
  username: string | null;
}

const SELECT = `SELECT f.id, f.kind, f.severity, f.rule, f.path, f.line, f.oid, f.fingerprint, f.found_at, f.accepted_reason, f.accepted_at, u.username
  FROM scan_finding f LEFT JOIN user u ON u.id = f.accepted_by`;

const shape = (r: Raw): FindingRow => ({
  id: r.id, kind: r.kind, severity: r.severity, rule: r.rule, path: r.path, line: r.line, oid: r.oid, fingerprint: r.fingerprint, foundAt: r.found_at,
  accepted: r.accepted_at === null ? null : { by: r.username ?? "someone removed", reason: r.accepted_reason ?? "", at: r.accepted_at },
});

/** Record what a pass found at `oid`; a fingerprint already recorded is left as it stands. Returns how many were new. */
export function recordFindings(db: Database, repoId: string, oid: string, findings: readonly Finding[], at = new Date().toISOString()): number {
  const insert = db.query(
    `INSERT OR IGNORE INTO scan_finding (repo_id, fingerprint, kind, severity, rule, path, line, oid, found_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  let fresh = 0;
  db.transaction(() => {
    for (const f of findings) fresh += insert.run(repoId, f.fingerprint, f.kind, f.severity, f.rule, f.path, f.line, oid, at).changes;
  })();
  return fresh;
}

/** When a pass ran, at what, and how many files it could not read (past the limits, or unaskable): a partial pass says so. */
export function noteScanRun(db: Database, repoId: string, kind: "push" | "nightly", oid: string, skipped = 0, at = new Date().toISOString()): void {
  db.query("INSERT INTO scan_run (repo_id, kind, oid, at, skipped) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (repo_id, kind) DO UPDATE SET oid = ?3, at = ?4, skipped = ?5").run(repoId, kind, oid, at, skipped);
}

export function lastScan(db: Database, repoId: string, kind: "push" | "nightly"): { at: string; skipped: number } | null {
  return db.query<{ at: string; skipped: number }, [string, string]>("SELECT at, skipped FROM scan_run WHERE repo_id = ?1 AND kind = ?2").get(repoId, kind) ?? null;
}

export function lastScanAt(db: Database, repoId: string, kind: "push" | "nightly"): string | null {
  return lastScan(db, repoId, kind)?.at ?? null;
}

/** Newest first, open before accepted; bounded. */
export function listFindings(db: Database, repoId: string, limit = 200): FindingRow[] {
  return db
    .query<Raw, [string, number]>(`${SELECT} WHERE f.repo_id = ?1 ORDER BY f.accepted_at IS NOT NULL, f.id DESC LIMIT ?2`)
    .all(repoId, limit)
    .map(shape);
}

export function getFinding(db: Database, repoId: string, id: number): FindingRow | undefined {
  const r = db.query<Raw, [string, number]>(`${SELECT} WHERE f.repo_id = ?1 AND f.id = ?2`).get(repoId, id);
  return r ? shape(r) : undefined;
}

/** The open high findings: each holds a release of this repository. */
export function openHigh(db: Database, repoId: string): FindingRow[] {
  return db
    .query<Raw, [string]>(`${SELECT} WHERE f.repo_id = ?1 AND f.severity = 'high' AND f.accepted_at IS NULL ORDER BY f.id`)
    .all(repoId)
    .map(shape);
}

export function counts(db: Database, repoId: string): { openHigh: number; open: number; accepted: number } {
  const r = db
    .query<{ high: number | null; open: number | null; accepted: number | null }, [string]>(
      `SELECT SUM(accepted_at IS NULL AND severity = 'high') AS high, SUM(accepted_at IS NULL) AS open, SUM(accepted_at IS NOT NULL) AS accepted
       FROM scan_finding WHERE repo_id = ?1`,
    )
    .get(repoId);
  return { openHigh: r?.high ?? 0, open: r?.open ?? 0, accepted: r?.accepted ?? 0 };
}

/** Mark an open finding accepted; false when it was not open. The caller has checked who and why. */
export function markAccepted(db: Database, repoId: string, id: number, userId: string, reason: string, at = new Date().toISOString()): boolean {
  return (
    db
      .query("UPDATE scan_finding SET accepted_by = ?3, accepted_reason = ?4, accepted_at = ?5 WHERE repo_id = ?1 AND id = ?2 AND accepted_at IS NULL")
      .run(repoId, id, userId, reason, at).changes === 1
  );
}

/** Repositories whose nightly pass is due: never run, or last run before `before`. Bounded. */
export function nightlyDue(db: Database, before: string, limit: number): string[] {
  return db
    .query<{ id: string }, [string, number]>(
      `SELECT r.id FROM repo r LEFT JOIN scan_run s ON s.repo_id = r.id AND s.kind = 'nightly'
       WHERE s.at IS NULL OR s.at < ?1 ORDER BY s.at IS NOT NULL, s.at LIMIT ?2`,
    )
    .all(before, limit)
    .map((r) => r.id);
}
