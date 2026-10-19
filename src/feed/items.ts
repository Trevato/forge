/**
 * The feed's candidates: what happened that a viewer may be told about, as
 * plain data. Every source reads through the access the rest of the forge
 * uses — events by repository visibility and then `audienceFilter`, asks by
 * what the viewer may decide, the ledger and money by what an owner may see
 * — so the feed cannot say what a page would not.
 */

import type { Database } from "bun:sqlite";
import type { Chips } from "../core/feed_chips.ts";
import { listDecidedIn } from "../core/decisions.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../core/events.ts";
import { getIssuesByNumbers, numberKey, type Issue } from "../core/issues.ts";
import {
  listDetachedMirrors,
  listOrigins,
  mirrorsByOrigin,
} from "../core/origins.ts";
import { joinMany, toldBy, type Pull } from "../core/pulls.ts";
import {
  canSeeOwnerFacts,
  getReposByIds,
  listReposWritableTo,
  type Repo,
} from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { watchedBy } from "../core/watches.ts";
import { chooseCandidates } from "./choose.ts";
import { askLinesFor } from "../web/studio/asks.ts";

export type FeedKind =
  | "run"
  | "ask"
  | "pull"
  | "decision"
  | "map"
  | "cost"
  // A post: something a person or the crew said — a tell opened, a reply
  // under one, a look of what a change made (#599).
  | "tell"
  | "reply"
  | "look"
  | "milestone"
  // A variant group: one choice among open siblings, or that it was made.
  | "choose"
  // A new version serving: what shipped, as the app's own news (#1811).
  | "release";

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
/** What a person asked to watch sits above plain news, and its landing with a failure. */
const WATCH_URGENCY = 2;
const LANDED_URGENCY = 4;
/** Something of the viewer's has stopped and only they can start it: a failure's weight. */
const FROZEN_URGENCY = 4;

/**
 * What the viewer watches (`core/watches.ts`), one item for each milestone:
 * how far it is and what merged since they last opened it, or that it
 * landed, or that it will not. A milestone with nothing new says nothing.
 */
function watchedCandidates(db: Database, viewer: User, now: number): Candidate[] {
  const out: Candidate[] = [];
  for (const w of watchedBy(db, viewer, now)) {
    if (w.state === "moving" && w.merged.length === 0) continue;
    const { done, total } = w.milestone.weight;
    const name = `“${clip(w.milestone.name, 60)}”`;
    const n = w.merged.length;
    const what =
      w.state === "landed"
        ? `${name} landed: ${done} of ${total} done`
        : w.state === "moving"
          ? `${name} is ${done} of ${total} done: ${n} merged since you last looked (${clip(w.merged.map((p) => p.title).join("; "), 80)})`
          : `${name} was ${w.state === "split" ? "split into smaller issues" : "dropped"}: it will not land as it was written`;
    out.push({
      id: w.itemId,
      kind: "milestone",
      repoId: w.repo.id,
      app: slug(w.repo),
      actorId: null,
      actor: null,
      at: w.at,
      link: `${base(w.repo)}/milestones/${w.milestone.issue.number}`,
      what,
      urgency: w.state === "landed" ? LANDED_URGENCY : WATCH_URGENCY,
      // The sentence is the milestone's, whatever led the ranking.
      said: what,
    });
  }
  return out;
}

/**
 * What froze on the viewer, as decisions only they can make (#1090): an
 * origin of theirs whose credential died, with the mirrors that stopped
 * with it, and each of their mirrors whose origin is gone. Read from what
 * is true now rather than from an event, so the item goes the moment the
 * thing is fixed and is there from the first boot that finds it.
 */
function frozenCandidates(
  db: Database,
  viewer: User,
  now: number,
): Candidate[] {
  const out: Candidate[] = [];
  const at = new Date(now).toISOString();
  const detached = listDetachedMirrors(db, { ownerId: viewer.id });
  const dead = listOrigins(db, viewer.id).filter((o) => o.needsReauth);
  const mirrors = mirrorsByOrigin(db, viewer.id);
  const repos = getReposByIds(db, [
    ...detached.map((m) => m.repoId),
    ...dead.flatMap((o) => {
      const first = mirrors.get(o.id)?.first;
      return first === undefined ? [] : [first];
    }),
  ]);
  for (const origin of dead) {
    const behind = mirrors.get(origin.id);
    const repo = behind === undefined ? undefined : repos.get(behind.first);
    if (behind === undefined || repo === undefined) continue;
    const n = behind.count;
    const host = URL.parse(origin.webUrl)?.host ?? origin.webUrl;
    const what = `${origin.login} at ${host} needs re-authorizing; ${n === 1 ? "1 mirror is" : `${n} mirrors are`} frozen`;
    out.push({
      id: `reauth:${origin.id}`,
      kind: "decision",
      repoId: repo.id,
      app: slug(repo),
      actorId: null,
      actor: null,
      at,
      link: "/settings/origins",
      what,
      urgency: FROZEN_URGENCY,
      said: what,
    });
  }
  for (const mirror of detached) {
    const repo = repos.get(mirror.repoId);
    if (repo === undefined) continue;
    const what = `${slug(repo)} is frozen; reconnect its origin`;
    out.push({
      id: `frozen:${repo.id}`,
      kind: "decision",
      repoId: repo.id,
      app: slug(repo),
      actorId: null,
      actor: null,
      at: mirror.detachedAt ?? at,
      link: `${base(repo)}#frozen`,
      what,
      urgency: FROZEN_URGENCY,
      said: what,
    });
  }
  return out;
}

export function candidatesFor(
  db: Database,
  viewer: User,
  now: number,
  chips?: Chips,
  /** False when the caller shows asks itself (the home pins them): they are not read twice. */
  withAsks = true,
): Candidate[] {
  const recent = listEventsVisibleTo(db, viewer, { limit: EVENT_WINDOW });
  const events = recent.filter(audienceFilter(db, viewer, recent));
  const writable = listReposWritableTo(db, viewer, { limit: 200 });
  const asks = withAsks ? askLinesFor(db, viewer, chips) : [];
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

  // Every event's subject in one read, not two per event (#2675).
  const issues = getIssuesByNumbers(
    db,
    events.flatMap((e) =>
      typeof e.payload["number"] === "number" && e.repoId !== null
        ? [{ repoId: e.repoId, number: e.payload["number"] }]
        : [],
    ),
  );
  const pulls = new Map(
    joinMany(
      db,
      [...issues.values()].filter((i) => i.kind === "pull"),
    ).map((p) => [p.id, p]),
  );
  const subjects: Subjects = {
    issue: (repoId, number) => issues.get(numberKey(repoId, number)),
    pull: (repoId, number) => {
      const issue = issues.get(numberKey(repoId, number));
      return issue === undefined ? undefined : pulls.get(issue.id);
    },
  };

  const out: Candidate[] = [];
  for (const e of events) {
    const repo = repos.get(e.repoId!);
    if (!repo) continue;
    const c = fromEvent(db, e, repo, owns(repo), subjects);
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
  out.push(...watchedCandidates(db, viewer, now));
  out.push(...frozenCandidates(db, viewer, now));
  out.push(...chooseCandidates(db, writable));
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

/** The conversations the window's events name, read once for all of them. */
interface Subjects {
  issue(repoId: string, number: number): Issue | undefined;
  pull(repoId: string, number: number): Pull | undefined;
}

function fromEvent(
  db: Database,
  e: ForgeEvent,
  repo: Repo,
  ownerFacts: boolean,
  subjects: Subjects,
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
  const pull = number === undefined ? undefined : subjects.pull(repo.id, number);
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
        what: `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} run ${state === "failed" ? "failed" : "finished"}${summary ? `: ${summary}` : ""}`,
      };
    }
    case "pull.opened":
      return { ...common, kind: "pull", link: change, what: `a change was opened${title ? `: ${clip(title)}` : ""}${toldWords}` };
    case "pull.merged":
      return { ...common, kind: "pull", link: change, what: `a change shipped${title ? `: ${clip(title)}` : ""}${toldWords}` };
    case "pull.reviewed":
      return { ...common, kind: "pull", link: change, what: `a change was reviewed${title ? `: ${clip(title)}` : ""}` };
    case "look.taken":
      return { ...common, kind: "look", link: base(repo), what: "a new picture of it is ready" };
    case "app.serving":
      return { ...common, kind: "release", link: base(repo), what: "a new version is serving" };
    // A tell is a post; a comment is a reply under it, in its own words.
    case "issue.opened": {
      if (number === undefined) return undefined;
      const told = subjects.issue(repo.id, number)?.title ?? "";
      return {
        ...common,
        kind: "tell",
        link: `${base(repo)}/tells/${number}`,
        what: told === "" ? `told #${number}` : clip(told),
      };
    }
    case "issue.commented":
    case "pull.commented": {
      if (number === undefined) return undefined;
      const said = typeof p["body"] === "string" ? p["body"].trim() : "";
      // A reply names what it answers: the tell's or the change's title.
      const on = clip(
        (e.kind === "issue.commented" ? subjects.issue(repo.id, number)?.title : title) ??
          `#${number}`,
        60,
      );
      return {
        ...common,
        kind: "reply",
        link:
          e.kind === "issue.commented"
            ? `${base(repo)}/tells/${number}`
            : change,
        what: said === "" ? `replied on “${on}”` : `on “${on}”: ${clip(said)}`,
      };
    }
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
