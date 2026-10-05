/**
 * The feed's candidates: what happened that a viewer may be told about, as
 * plain data. Every source reads through the access the rest of the forge
 * uses — events by repository visibility and then `audienceFilter`, asks by
 * what the viewer may decide, the ledger and money by what an owner may see
 * — so the feed cannot say what a page would not.
 */

import type { Database } from "bun:sqlite";
import { listDecidedIn } from "../core/decisions.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../core/events.ts";
import { getPull, toldBy } from "../core/pulls.ts";
import {
  canSeeOwnerFacts,
  getReposByIds,
  listReposWritableTo,
  type Repo,
} from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { askLinesFor } from "../web/studio/asks.ts";

export type FeedKind = "run" | "ask" | "pull" | "decision" | "map" | "cost";

/** What a candidate is, before it is ranked and worded. */
export interface Candidate {
  readonly id: string;
  readonly kind: FeedKind;
  readonly repoId: string;
  /** `owner/name`. */
  readonly app: string;
  readonly actorId: string | null;
  /** The actor's username. */
  readonly actor: string | null;
  readonly at: string;
  readonly link: string;
  /** What happened, as a clause: the reason when recency or urgency leads. */
  readonly what: string;
  /** 0 for news; an ask or a failure is more. */
  readonly urgency: number;
  /** When set, the sentence as it is: a share says who shared it. */
  readonly said?: string;
  /** For an ask: what it asks, the answers, what happens if nobody acts, and its rank. */
  readonly ask?: FeedAsk;
}

export interface FeedAsk {
  readonly decision: string;
  readonly options: readonly string[];
  readonly ifNothing: string;
  /** How much it matters (`consequenceOf`); higher first. */
  readonly rank: number;
  readonly why: string;
}

export const EVENT_WINDOW = 300;
const COST_FLOOR_USD = 1;
const clip = (s: string, n = 120): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const slug = (r: Repo): string => `${r.ownerName}/${r.name}`;
const base = (r: Repo): string => `/${r.ownerName}/${r.name}`;

/** Every ask sits above the news (a failed run is 4); among asks, consequence alone orders them. */
const ASK_URGENCY_FLOOR = 5;

export function candidatesFor(
  db: Database,
  viewer: User,
  now: number,
): Candidate[] {
  const events = listEventsVisibleTo(db, viewer, { limit: EVENT_WINDOW }).filter(
    audienceFilter(db, viewer),
  );
  const writable = listReposWritableTo(db, viewer, { limit: 200 });
  const asks = askLinesFor(db, viewer);
  const decided = listDecidedIn(
    db,
    writable.map((r) => r.id),
  );
  const repos = getReposByIds(db, [
    ...events.map((e) => e.repoId!),
    ...asks.map((a) => a.repoId),
  ]);
  for (const r of writable) repos.set(r.id, r);

  const names = new Map<string, string | null>();
  const nameOf = (id: string | null): string | null => {
    if (id === null) return null;
    if (!names.has(id)) names.set(id, getUserById(db, id)?.username ?? null);
    return names.get(id) ?? null;
  };
  const owner = new Map<string, boolean>();
  const owns = (repo: Repo): boolean => {
    if (!owner.has(repo.id))
      owner.set(repo.id, canSeeOwnerFacts(db, repo, viewer));
    return owner.get(repo.id)!;
  };

  const out: Candidate[] = [];
  for (const e of events) {
    const repo = repos.get(e.repoId!);
    if (!repo) continue;
    const c = fromEvent(db, e, repo, owns(repo));
    if (c) out.push({ ...c, actor: nameOf(e.actorId) });
  }
  for (const a of asks) {
    const repo = repos.get(a.repoId);
    if (!repo) continue;
    out.push({
      id: `ask:${a.id}`,
      kind: "ask",
      repoId: repo.id,
      app: slug(repo),
      actorId: null,
      actor: null,
      at: new Date(now).toISOString(),
      link: a.link,
      what: a.line,
      // The same order as /asks: the consequence score, nothing else.
      urgency: ASK_URGENCY_FLOOR + a.consequence.score / 20,
      ask: {
        decision: a.words.decision,
        options: a.words.options,
        ifNothing: a.words.ifNothing,
        rank: Math.round(a.consequence.score * 100) / 100,
        why: a.consequence.why,
      },
    });
  }
  for (const d of decided) {
    const repo = repos.get(d.repoId);
    if (!repo) continue;
    out.push({
      id: `decision:${d.id}`,
      kind: "decision",
      repoId: repo.id,
      app: slug(repo),
      actorId: null,
      actor: null,
      at: d.outcomeAt ?? d.createdAt,
      link: `${base(repo)}/pulls`,
      what: clip(`${d.by} chose “${clip(d.answer, 40)}” on a ${d.kind} and it ended ${d.outcome}`),
      urgency: 0,
    });
  }
  return out;
}

type Partial = Omit<Candidate, "actor">;

function fromEvent(
  db: Database,
  e: ForgeEvent,
  repo: Repo,
  ownerFacts: boolean,
): Partial | undefined {
  const common = {
    id: `event:${e.id}`,
    repoId: repo.id,
    app: slug(repo),
    actorId: e.actorId,
    at: e.createdAt,
    urgency: 0,
  };
  const p = e.payload;
  const number = typeof p["number"] === "number" ? p["number"] : undefined;
  const pull = number === undefined ? undefined : getPull(db, repo.id, number);
  const title = pull?.title ?? "";
  const told = pull === undefined ? null : toldBy(db, pull);
  const toldParts = [
    ...(told === null ? [] : [`told by ${told}`]),
    ...(pull?.authorIsAgent ? [`by ${pull.authorName}`] : []),
  ].join(", ");
  const toldWords = toldParts === "" ? "" : ` (${toldParts})`;
  const change = number === undefined ? base(repo) : `${base(repo)}/changes/${number}`;
  switch (e.kind) {
    case "run.finished": {
      const state = p["state"] === "failed" ? "failed" : "ok";
      const kind = typeof p["kind"] === "string" ? p["kind"] : "run";
      const cost = typeof p["costUsd"] === "number" ? p["costUsd"] : 0;
      const link = `${base(repo)}/runs/${String(p["runId"] ?? "")}`;
      const summary = clip(typeof p["summary"] === "string" ? p["summary"] : "");
      if (kind === "agent" && cost >= COST_FLOOR_USD && ownerFacts)
        return {
          ...common,
          kind: "cost",
          link,
          what: `a run cost $${cost.toFixed(2)}${summary ? `: ${summary}` : ""}`,
        };
      return {
        ...common,
        kind: "run",
        link,
        urgency: state === "failed" ? 4 : 0,
        what: `a ${kind} run ${state === "failed" ? "failed" : "finished"}${summary ? `: ${summary}` : ""}`,
      };
    }
    case "pull.opened":
      return { ...common, kind: "pull", link: change, what: `a change was opened${title ? `: ${clip(title)}` : ""}${toldWords}` };
    case "pull.merged":
      return { ...common, kind: "pull", link: change, what: `a change shipped${title ? `: ${clip(title)}` : ""}${toldWords}` };
    case "pull.reviewed":
      return { ...common, kind: "pull", link: change, what: `a change was reviewed${title ? `: ${clip(title)}` : ""}` };
    case "look.taken":
    case "app.serving":
      return {
        ...common,
        kind: "pull",
        link: base(repo),
        what: e.kind === "look.taken" ? "a new preview picture is ready" : "a new version is serving",
      };
    case "issue.blocked":
    case "issue.unblocked":
      return {
        ...common,
        kind: "map",
        link: `${base(repo)}/map`,
        what:
          e.kind === "issue.blocked"
            ? `#${String(number)} now waits for #${String(p["blockedBy"])}`
            : `#${String(number)} no longer waits for #${String(p["blockedBy"])}`,
      };
    default:
      return undefined;
  }
}
