/**
 * How long an app's golden path took: from New app to the first preview that
 * served, and to the first production deploy after the first merged pull.
 * Plain data in, plain data out; a figure is left out until it exists.
 */

import type { Database } from "bun:sqlite";
import type { AppRecord } from "../core/apps.ts";

export interface GoldenPath {
  readonly firstPreviewMs?: number;
  readonly firstProductionChangeMs?: number;
}

export function goldenPath(db: Database, app: Pick<AppRecord, "repoId" | "createdAt">): GoldenPath {
  const born = Date.parse(app.createdAt);
  if (Number.isNaN(born)) return {};
  const preview = db
    .query<{ at: string | null }, [string]>(
      `SELECT MIN(serving_at) AS at FROM run
        WHERE repo_id = ?1 AND kind = 'deploy' AND env LIKE 'pull-%' AND serving_at IS NOT NULL`,
    )
    .get(app.repoId)?.at;
  const merged = db
    .query<{ at: string | null }, [string]>(
      `SELECT MIN(p.merged_at) AS at FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE i.repo_id = ?1 AND p.base_branch = r.default_branch AND p.merged_at IS NOT NULL`,
    )
    .get(app.repoId)?.at;
  const production =
    merged == null
      ? null
      : db
          .query<{ at: string | null }, [string, string]>(
            `SELECT MIN(serving_at) AS at FROM run
              WHERE repo_id = ?1 AND kind = 'deploy' AND env = 'production'
                AND created_at >= ?2 AND serving_at IS NOT NULL`,
          )
          .get(app.repoId, merged)?.at;
  const since = (at: string | null | undefined): number | undefined => {
    const ms = at == null ? NaN : Date.parse(at) - born;
    return Number.isNaN(ms) ? undefined : Math.max(0, ms);
  };
  const firstPreviewMs = since(preview);
  const firstProductionChangeMs = since(production);
  return {
    ...(firstPreviewMs === undefined ? {} : { firstPreviewMs }),
    ...(firstProductionChangeMs === undefined ? {} : { firstProductionChangeMs }),
  };
}

/** `14s`, `2m 14s`, `9m`, `1h 5m`, `3d`: two units at most. */
export function spanWords(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 || m >= 10 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** The one dense line, or `""` while there is nothing to show. */
export function goldenPathLine(path: GoldenPath): string {
  const parts: string[] = [];
  if (path.firstPreviewMs !== undefined)
    parts.push(`first preview ${spanWords(path.firstPreviewMs)} after New app`);
  if (path.firstProductionChangeMs !== undefined)
    parts.push(`in production ${spanWords(path.firstProductionChangeMs)}`);
  return parts.join(" · ");
}
