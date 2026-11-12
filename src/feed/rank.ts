/**
 * The ranker. A score is three terms — urgency, affinity, recency — less a
 * decay for each item already placed from the same app or the same actor,
 * so one noisy source cannot fill the feed. Negatives weigh strongly: the
 * affinity term goes as low as it goes high ×2. The reason is the sentence
 * for the term that led, so it is never a different story than the order.
 */

import { decay, type Affinity, type Weighted, type Why } from "./affinity.ts";
import type { Candidate, FeedAsk, FeedLook } from "./items.ts";
import type { PathStep } from "../flow/path.ts";
import type { Settled } from "./settled.ts";

export interface FeedItem {
  readonly id: string;
  readonly kind: Candidate["kind"];
  /** `owner/name`. */
  readonly app: string;
  readonly actor: string | null;
  readonly at: string;
  readonly link: string;
  /** What happened, in the post's own words. */
  readonly what: string;
  /** One sentence: why this, and why here. */
  readonly reason: string;
  readonly score: number;
  /** For an ask: the decision, options, default and rank. */
  readonly ask?: FeedAsk;
  /** A folded post: its first titles with their links, and how many more. */
  readonly lines?: readonly { readonly text: string; readonly link: string }[];
  readonly more?: number;
  /** For a look: which picture it is of. */
  readonly look?: FeedLook;
  /** For a post about a pull or an issue that is over: how it ended. Absent while open. */
  readonly settled?: Settled;
  /** How many people like it, and whether this viewer does (`feed/likes.ts`); absent when nobody does. */
  readonly likes?: number;
  readonly liked?: boolean;
  /** For a post about a pull: which of check, review, land, live it is at, and why. */
  readonly step?: PathStep;
}

const RECENCY_MAX = 4;
const RECENCY_HALF_LIFE_MS = 6 * 3600 * 1000;
const AFFINITY_WEIGHT = 1.5;
const AFFINITY_MAX = 9;
const AFFINITY_MIN = -18;
export const REPEAT_APP = 1.2;
export const REPEAT_ACTOR = 0.6;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/** `just now`, `3 hours ago`, `yesterday`, `5 days ago`. */
export function ago(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} minutes ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const VERB: Partial<Record<Why, string>> = {
  shipped: "shipped",
  proposed: "proposed",
  told: "told",
  decided: "decided on",
  opened: "opened",
  dwelled: "lingered on",
  steered: "steered",
  swiped: "swiped through",
  shared: "shared",
};

function affinityReason(c: Candidate, app: Weighted, actor: Weighted, now: number): string {
  const lead = app.score >= actor.score ? app : actor;
  const why = lead.why;
  const when = lead.at === undefined ? "" : ` ${ago(lead.at, now)}`;
  if (lead === actor)
    return why === "crew"
      ? `because ${c.actor ?? "they"} is on your crew`
      : `because you ${VERB[why as Why] ?? "worked with"} ${c.actor ?? "them"}${when}`;
  if (why === "owns") return `because you own ${c.app}`;
  if (why === "works on") return `because you work on ${c.app}`;
  if (why === "pinned") return `because you pinned ${c.app}`;
  const thing = lead.label !== undefined ? `“${lead.label}”` : c.app;
  return `because you ${VERB[why as Why] ?? "worked on"} ${thing}${when}`;
}

interface Scored {
  readonly c: Candidate;
  readonly base: number;
}

/** The sentence for the term that led, worded only for an item that is placed. */
function reasonOf(c: Candidate, aff: Affinity, now: number): string {
  if (c.said !== undefined) return c.said;
  const app = aff.app(c.repoId);
  const actor = c.actorId === null ? aff.get("actor:") : aff.actor(c.actorId);
  const affinity = affinityOf(app, actor);
  const recency = recencyOf(c, now);
  return c.urgency >= Math.max(affinity, recency)
    ? c.what
    : affinity >= recency
      ? affinityReason(c, app, actor, now)
      : `${c.what}, ${ago(Date.parse(c.at), now)}`;
}

const affinityOf = (app: Weighted, actor: Weighted): number =>
  clamp(AFFINITY_WEIGHT * (app.score + 0.5 * actor.score), AFFINITY_MIN, AFFINITY_MAX);

const recencyOf = (c: Candidate, now: number): number =>
  RECENCY_MAX * decay(now - Date.parse(c.at), RECENCY_HALF_LIFE_MS);

export function rank(
  candidates: readonly Candidate[],
  aff: Affinity,
  now: number,
  /** Place only the best `upto`: the same first items, without ordering the rest. */
  upto: number = Infinity,
): FeedItem[] {
  const scored: Scored[] = candidates.map((c) => {
    const app = aff.app(c.repoId);
    const actor = c.actorId === null ? aff.get("actor:") : aff.actor(c.actorId);
    return { c, base: c.urgency + affinityOf(app, actor) + recencyOf(c, now) };
  });

  // Greedy: place the best remaining, then charge its source against the
  // rest. Placed scores never rise, which is what lets a cursor resume.
  const out: FeedItem[] = [];
  const perApp = new Map<string, number>();
  const perActor = new Map<string, number>();
  const rest = [...scored];
  while (rest.length > 0 && out.length < upto) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const s = rest[i]!;
      const adj =
        s.base -
        REPEAT_APP * (perApp.get(s.c.repoId) ?? 0) -
        REPEAT_ACTOR * (s.c.actorId === null ? 0 : (perActor.get(s.c.actorId) ?? 0));
      const better =
        adj > bestScore || (adj === bestScore && s.c.id > rest[best]!.c.id);
      if (better) {
        best = i;
        bestScore = adj;
      }
    }
    const [s] = rest.splice(best, 1);
    perApp.set(s!.c.repoId, (perApp.get(s!.c.repoId) ?? 0) + 1);
    if (s!.c.actorId !== null)
      perActor.set(s!.c.actorId, (perActor.get(s!.c.actorId) ?? 0) + 1);
    out.push({
      id: s!.c.id,
      kind: s!.c.kind,
      app: s!.c.app,
      actor: s!.c.actor,
      at: s!.c.at,
      link: s!.c.link,
      what: s!.c.said ?? s!.c.what,
      reason: reasonOf(s!.c, aff, now),
      score: Math.round(bestScore * 1e6) / 1e6,
      ...(s!.c.ask === undefined ? {} : { ask: s!.c.ask }),
      ...(s!.c.lines === undefined ? {} : { lines: s!.c.lines, more: s!.c.more ?? 0 }),
      ...(s!.c.look === undefined ? {} : { look: s!.c.look }),
    });
  }
  return out;
}
