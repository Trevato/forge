/**
 * What is moving through the forge, for the home (#8015): the builds running
 * now, the changes that just shipped, and the pipeline in four words.
 * Plain data out. Every row is read for a viewer: a repository they cannot
 * read, and a sealed report, are never named.
 */

import type { Database } from "bun:sqlite";
import { canRead, getReposByIds, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { writeStamp } from "../core/write_clock.ts";
import type { PipelineStage } from "./pipeline.ts";

/** One line of a list: who, what, where it goes, and when. */
export interface MovingRow {
  readonly who: string;
  readonly title: string;
  readonly href: string;
  readonly at: string;
  /** `owner/name`, for the row's title attribute. */
  readonly repo: string;
}

export const MOVING_ROWS = 3;
/** Rows read before the viewer's access filters them; bounded, so the read is. */
const SCAN = 40;

interface Raw {
  repo_id: string;
  number: number;
  title: string;
  sealed: number;
  who: string | null;
  at: string;
}

const RAW_MAX_AGE_MS = 30_000;
const kept = new WeakMap<Database, Map<string, { stamp: string; at: number; raw: Raw[] }>>();

/** A scan read once per write: the same rows serve every viewer until anything is written (or 30 s pass). */
function scanned(db: Database, key: string, read: () => Raw[], now = Date.now()): Raw[] {
  const stamp = writeStamp(db);
  if (stamp === undefined) return read();
  let byKey = kept.get(db);
  if (byKey === undefined) kept.set(db, (byKey = new Map()));
  const had = byKey.get(key);
  if (had !== undefined && had.stamp === stamp && now - had.at < RAW_MAX_AGE_MS) return had.raw;
  const raw = read();
  byKey.set(key, { stamp, at: now, raw });
  return raw;
}

function visible(db: Database, viewer: User, raw: readonly Raw[], path: string, limit: number): MovingRow[] {
  const repos = getReposByIds(db, raw.map((r) => r.repo_id));
  const readable = new Map<string, Repo | undefined>();
  const out: MovingRow[] = [];
  for (const r of raw) {
    if (r.sealed !== 0) continue;
    if (!readable.has(r.repo_id)) {
      const repo = repos.get(r.repo_id);
      readable.set(r.repo_id, repo !== undefined && canRead(db, repo, viewer) ? repo : undefined);
    }
    const repo = readable.get(r.repo_id);
    if (repo === undefined) continue;
    out.push({
      who: r.who ?? "",
      title: r.title,
      href: `/${repo.ownerName}/${repo.name}/${path}/${r.number}`,
      at: r.at,
      repo: `${repo.ownerName}/${repo.name}`,
    });
    if (out.length === limit) break;
  }
  return out;
}

/** Agent builds running now (reviews are not building), newest first, each on the issue it works. */
export function readBuilding(db: Database, viewer: User, limit = MOVING_ROWS): MovingRow[] {
  const raw = scanned(db, "building", () => db
    .query<Raw, [number]>(
      `SELECT r.repo_id, i.number, i.title, i.sealed, u.username AS who, COALESCE(r.started_at, r.created_at) AS at
         FROM run r JOIN issue i ON i.id = r.issue_id LEFT JOIN user u ON u.id = r.actor_id
        WHERE r.kind = 'agent' AND r.state = 'running' AND r.reason != 'review'
        ORDER BY at DESC LIMIT ?1`,
    )
    .all(SCAN));
  return visible(db, viewer, raw, "issues", limit);
}

/** Changes merged most recently, newest first, each linking to its pull. */
export function readShipped(db: Database, viewer: User, limit = MOVING_ROWS): MovingRow[] {
  const raw = scanned(db, "shipped", () => db
    .query<Raw, [number]>(
      `SELECT i.repo_id, i.number, i.title, i.sealed, u.username AS who, p.merged_at AS at
         FROM pull p JOIN issue i ON i.id = p.issue_id LEFT JOIN user u ON u.id = p.merged_by
        WHERE p.merged_at IS NOT NULL
        ORDER BY p.merged_at DESC LIMIT ?1`,
    )
    .all(SCAN));
  return visible(db, viewer, raw, "pulls", limit);
}

/** The pipeline in the four words the forge uses; each count is the sum of the `/boards` stages it names. */
export interface Now {
  readonly check: number;
  readonly review: number;
  readonly land: number;
  readonly live: number;
}

export function nowOf(stages: readonly PipelineStage[]): Now {
  const n = (key: PipelineStage["key"]): number => {
    const s = stages.find((x) => x.key === key);
    return s === undefined ? 0 : s.waiting + s.active;
  };
  return {
    check: n("check-queue") + n("checking"),
    review: n("review"),
    land: n("approved"),
    live: n("live"),
  };
}
