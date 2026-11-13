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

/**
 * Both figures are firsts, so once an app has them they never change, and
 * until then a minute-old answer is as good. The apps list asked three
 * questions per app per request (560 a minute, 16 s of every 120 on the
 * forge's one thread, 2026-11-13). Off under `bun test` (NODE_ENV=test).
 */
const GOLDEN_REUSE_MS = process.env["NODE_ENV"] === "test" ? 0 : 60_000;
const goldenKept = new WeakMap<Database, Map<string, { at: number; path: GoldenPath }>>();

export function goldenPath(db: Database, app: Pick<AppRecord, "repoId" | "createdAt">): GoldenPath {
  if (GOLDEN_REUSE_MS === 0) return readGoldenPath(db, app);
  let kept = goldenKept.get(db);
  if (kept === undefined) goldenKept.set(db, (kept = new Map()));
  const key = `${app.repoId} ${app.createdAt}`;
  const hit = kept.get(key);
  const now = Date.now();
  const whole = (p: GoldenPath): boolean => p.firstPreviewMs !== undefined && p.firstProductionChangeMs !== undefined;
  if (hit !== undefined && (whole(hit.path) || now - hit.at < GOLDEN_REUSE_MS)) return hit.path;
  const path = readGoldenPath(db, app);
  kept.set(key, { at: now, path });
  return path;
}

function readGoldenPath(db: Database, app: Pick<AppRecord, "repoId" | "createdAt">): GoldenPath {
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

/**
 * The first-preview figure for many apps in one query, keyed by repo id; an
 * app with none (or an unreadable birth date) has no entry.
 */
export function firstPreviews(
  db: Database,
  apps: readonly Pick<AppRecord, "repoId" | "createdAt">[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (apps.length === 0) return out;
  const marks = apps.map(() => "?").join(",");
  const rows = db
    .query<{ repo_id: string; at: string | null }, string[]>(
      `SELECT repo_id, MIN(serving_at) AS at FROM run
        WHERE repo_id IN (${marks}) AND kind = 'deploy' AND env LIKE 'pull-%' AND serving_at IS NOT NULL
        GROUP BY repo_id`,
    )
    .all(...apps.map((a) => a.repoId));
  const born = new Map(apps.map((a) => [a.repoId, Date.parse(a.createdAt)]));
  for (const r of rows) {
    const ms = Date.parse(r.at ?? "") - (born.get(r.repo_id) ?? NaN);
    if (!Number.isNaN(ms)) out.set(r.repo_id, Math.max(0, ms));
  }
  return out;
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
