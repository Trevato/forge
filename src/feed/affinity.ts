/**
 * What a viewer cares about, as decayed counts per app and per actor. No
 * model: a seed from what they own, pin and have on their crew, plus every
 * act they have done — merging, opening, telling, and what they did with
 * feed items — each weighed and halved every week. The strongest part of a
 * score is kept by name, because the ranker's reason is made from it.
 */

import type { Database } from "bun:sqlite";
import { listDecidedIn } from "../core/decisions.ts";
import type { InteractionKind } from "../core/interactions.ts";
import { listInteractions } from "../core/interactions.ts";
import { getPull } from "../core/pulls.ts";
import { listReposWritableTo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";

export const HALF_LIFE_MS = 7 * 24 * 3600 * 1000;
export const decay = (ageMs: number, halfLife = HALF_LIFE_MS): number =>
  0.5 ** (Math.max(0, ageMs) / halfLife);

/** Why a part exists — the word the reason sentence is built around. */
export type Why =
  | "owns"
  | "works on"
  | "pinned"
  | "crew"
  | "shipped"
  | "proposed"
  | "told"
  | "decided"
  | InteractionKind;

/** What each interaction is worth. Negatives outweigh the positives. */
export const INTERACTION_WEIGHT: Readonly<Record<InteractionKind, number>> = {
  opened: 1,
  dwelled: 1.5,
  steered: 3,
  told: 3,
  swiped: 0.5,
  shipped: 4,
  shared: 2,
  dismissed: -4,
  muted: -8,
};

export interface Weighted {
  readonly score: number;
  /** The part with the largest size, and when it last counted. */
  readonly why: Why | undefined;
  readonly at: number | undefined;
  /** What that part was about, when it was one thing ("Fix the nav"). */
  readonly label: string | undefined;
}

const NONE: Weighted = {
  score: 0,
  why: undefined,
  at: undefined,
  label: undefined,
};

interface Part {
  sum: number;
  at: number;
  label: string | undefined;
}

export class Affinity {
  private readonly parts = new Map<string, Map<Why, Part>>();

  add(
    key: string,
    why: Why,
    weight: number,
    at: number,
    label?: string | undefined,
  ): void {
    let byWhy = this.parts.get(key);
    if (!byWhy) this.parts.set(key, (byWhy = new Map()));
    const part = byWhy.get(why);
    if (!part) byWhy.set(why, { sum: weight, at, label });
    else {
      part.sum += weight;
      if (at >= part.at) {
        part.at = at;
        if (label !== undefined) part.label = label;
      }
    }
  }

  get(key: string): Weighted {
    const byWhy = this.parts.get(key);
    if (!byWhy) return NONE;
    let score = 0;
    let top: { why: Why; part: Part } | undefined;
    for (const [why, part] of byWhy) {
      score += part.sum;
      if (!top || Math.abs(part.sum) > Math.abs(top.part.sum))
        top = { why, part };
    }
    return {
      score,
      why: top?.why,
      at: top?.part.at,
      label: top?.part.label,
    };
  }

  app = (repoId: string): Weighted => this.get(`app:${repoId}`);
  actor = (userId: string): Weighted => this.get(`actor:${userId}`);
}

/** What the viewer's own past acts on the outbox count for. */
const OWN_ACTS: Readonly<Record<string, { why: Why; weight: number }>> = {
  "pull.merged": { why: "shipped", weight: 3 },
  "pull.opened": { why: "proposed", weight: 1.5 },
  "issue.opened": { why: "told", weight: 2 },
  "prompt.told": { why: "told", weight: 2 },
};

export function affinityFor(
  db: Database,
  viewer: User,
  now: number,
): Affinity {
  const aff = new Affinity();
  const mine = listReposWritableTo(db, viewer, {
    limit: 200,
    withoutArchived: true,
  });
  for (const repo of mine)
    aff.add(
      `app:${repo.id}`,
      repo.ownerId === viewer.id ? "owns" : "works on",
      2,
      now,
    );
  for (const row of db
    .query<{ repo_id: string }, [string]>(
      "SELECT repo_id FROM pin WHERE user_id = ?1",
    )
    .all(viewer.id))
    aff.add(`app:${row.repo_id}`, "pinned", 1, now);
  seedCrew(db, aff, mine, now);
  seedOwnActs(db, aff, viewer, now);
  for (const d of listDecidedIn(
    db,
    mine.map((r) => r.id),
  )) {
    const at = Date.parse(d.outcomeAt ?? d.createdAt);
    if (d.outcome === "shipped")
      aff.add(`app:${d.repoId}`, "decided", decay(now - at), at);
  }
  for (const i of listInteractions(db, viewer.id)) {
    const at = Date.parse(i.createdAt);
    const w = INTERACTION_WEIGHT[i.kind] * decay(now - at);
    if (i.repoId !== null) aff.add(`app:${i.repoId}`, i.kind, w, at);
    if (i.actorId !== null) aff.add(`actor:${i.actorId}`, i.kind, w, at);
  }
  return aff;
}

function seedCrew(
  db: Database,
  aff: Affinity,
  repos: readonly Repo[],
  now: number,
): void {
  if (repos.length === 0) return;
  const marks = repos.map((_, n) => `?${n + 1}`).join(",");
  for (const row of db
    .query<{ user_id: string }, string[]>(
      `SELECT DISTINCT user_id FROM repo_crew WHERE repo_id IN (${marks})`,
    )
    .all(...repos.map((r) => r.id)))
    aff.add(`actor:${row.user_id}`, "crew", 1, now);
}

function seedOwnActs(
  db: Database,
  aff: Affinity,
  viewer: User,
  now: number,
): void {
  const kinds = Object.keys(OWN_ACTS);
  const rows = db
    .query<
      { kind: string; repo_id: string; payload: string; created_at: string },
      string[]
    >(
      `SELECT kind, repo_id, payload, created_at FROM event
       WHERE actor_id = ?1 AND repo_id IS NOT NULL
         AND kind IN (${kinds.map((_, n) => `?${n + 2}`).join(",")})
       ORDER BY id DESC LIMIT 200`,
    )
    .all(viewer.id, ...kinds);
  for (const row of rows) {
    const act = OWN_ACTS[row.kind]!;
    const at = Date.parse(row.created_at);
    let label: string | undefined;
    try {
      const number = (JSON.parse(row.payload) as { number?: unknown }).number;
      if (typeof number === "number" && row.kind.startsWith("pull."))
        label = getPull(db, row.repo_id, number)?.title;
    } catch {
      // A payload that is not JSON names nothing.
    }
    aff.add(
      `app:${row.repo_id}`,
      act.why,
      act.weight * decay(now - at),
      at,
      label,
    );
  }
}
