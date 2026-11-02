/**
 * The feed's candidates: what happened that a viewer may be told about, as
 * plain data. Every source reads through the access the rest of the forge
 * uses — events by repository visibility and then `audienceFilter`, asks by
 * what the viewer may decide, the ledger and money by what an owner may see
 * — so the feed cannot say what a page would not.
 */

import type { Database } from "bun:sqlite";
import { isEnvName, type EnvName } from "../apps/data.ts";
import type { Chips } from "../core/feed_chips.ts";
import { listDecidedIn } from "../core/decisions.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { listEventsVisibleTo, type ForgeEvent } from "../core/events.ts";
import { getReview } from "../core/reviews.ts";
import { commentAnchor, getIssuesByIds, getIssuesByNumbers, numberKey, type Issue } from "../core/issues.ts";
import {
  listDetachedMirrors,
  listOrigins,
  mirrorsByOrigin,
} from "../core/origins.ts";
import { joinMany, toldBy, type Pull } from "../core/pulls.ts";
import {
  canSeeOwnerFacts,
  onCrew,
  getReposByIds,
  listReposWritableTo,
  type Repo,
} from "../core/repos.ts";
import { getRunErrorLine } from "../core/runs.ts";
import { getUserById, type User } from "../core/users.ts";
import { watchedBy } from "../core/watches.ts";
import { CLOG_NOTE_WINDOW_MS, flattenNote } from "../flow/clog_note.ts";
import { chooseCandidates } from "./choose.ts";
import type { Foldable } from "./fold.ts";
import { writeStamp } from "../core/write_clock.ts";
import { Stamped } from "../kernel/stamped.ts";
import { QUIET_WINDOW_MS, quietRunEventIds } from "./quiet.ts";
import { hotSays, standingHot, standingWide, wideSays } from "../crew/hot_files.ts";
import { ago } from "./rank.ts";
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
  /** Set on a post that may fold into a burst (`fold.ts`). */
  readonly fold?: Foldable;
  /** On a folded post: the first titles, each linking to its own thing, and how many more. */
  readonly lines?: readonly { readonly text: string; readonly link: string }[];
  readonly more?: number;
  /** For a look: the picture's environment and commit; the page finds the thumbnail. */
  readonly look?: FeedLook;
}

export interface FeedLook {
  readonly env: EnvName;
  readonly commitOid: string;
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

/** A run that cost enough to be a post of its own is never quiet. */
const cheap = (e: ForgeEvent): boolean => {
  const cost = e.payload["costUsd"];
  return !(typeof cost === "number" && cost >= COST_FLOOR_USD);
};

/** What one read of the viewer's recent events found: the heard ones and the quiet runs among them. */
interface Heard {
  readonly heard: ForgeEvent[];
  /** Quiet `run.finished` events of the last day, by id. */
  readonly quiet: Set<string>;
  readonly finished: ForgeEvent[];
}

const heardCache = new WeakMap<Database, Stamped<Heard>>();

/**
 * The viewer's visible recent events and which of the last day's runs among
 * them were quiet, worked out once and shared by the timeline filter and the
 * count (both read it under the same write stamp). A quiet run older than the
 * window stays a post, so none vanishes uncounted.
 */
function heardBy(db: Database, viewer: User, now: number): Heard {
  const work = (): Heard => {
    const recent = listEventsVisibleTo(db, viewer, { limit: EVENT_WINDOW });
    const heard = recent.filter(audienceFilter(db, viewer, recent));
    const since = new Date(now - QUIET_WINDOW_MS).toISOString();
    const finished = heard.filter(
      (e) => e.kind === "run.finished" && cheap(e) && e.createdAt >= since,
    );
    return { heard, finished, quiet: quietRunEventIds(db, finished) };
  };
  const stamp = writeStamp(db);
  if (stamp === undefined) return work();
  let cache = heardCache.get(db);
  if (cache === undefined) {
    cache = new Stamped<Heard>({ maxEntries: 100, maxAgeMs: 60_000 });
    heardCache.set(db, cache);
  }
  return cache.get(`${viewer.id}|${Math.floor(now / 60_000)}`, stamp, work);
}

/**
 * How many quiet runs the viewer was spared in the last day, and where each
 * was: the repository and the agent, so the viewer's mutes and chips apply.
 */
export function quietRunsFor(
  db: Database,
  viewer: User,
  now: number,
): { repoId: string; actorId: string | null; id: string }[] {
  const { quiet, finished } = heardBy(db, viewer, now);
  const repos = getReposByIds(db, finished.map((e) => e.repoId!));
  return finished
    .filter((e) => quiet.has(e.id) && repos.get(e.repoId!)?.archivedAt == null)
    .map((e) => ({ repoId: e.repoId!, actorId: e.actorId, id: e.id }));
}
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

/**
 * Builds the picker holds because a file they name is in 5 or more open
 * pulls (#5934): one post per repository the viewer writes to, read from
 * what the picker said last, so it goes when the pile drains.
 */
function hotCandidates(writable: readonly Repo[]): Candidate[] {
  const out: Candidate[] = [];
  for (const repo of writable) {
    const standing = standingHot(repo.id);
    const wide = standingWide(repo.id);
    if (standing === undefined && wide === undefined) continue;
    const wideSuffix = wide === undefined ? "" : wideSays(wide.wide);
    let what: string;
    if (standing === undefined) {
      what = `${wideSuffix} - close or rebase.`;
    } else {
      const n = standing.holds.length;
      const more = n > 1 ? ` And ${n - 1} more.` : "";
      const held = `${n === 1 ? "1 build waits" : `${n} builds wait`} on hot files: ${hotSays(standing.holds[0]!)}${more}`;
      what = wideSuffix === "" ? held : `${held} ${wideSuffix}.`;
    }
    out.push({
      id: `hot:${repo.id}`,
      kind: "map",
      repoId: repo.id,
      app: slug(repo),
      actorId: null,
      actor: null,
      at: (standing ?? wide!).at,
      link: `${base(repo)}/map`,
      what: clip(what),
      urgency: 0,
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
  // A quiet run is counted at the end of the first page, not posted.
  const { heard, quiet } = heardBy(db, viewer, now);
  const events = heard.filter((e) => !quiet.has(e.id));
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

  const logs = new Map<string, boolean>();
  const readsLogs = (repo: Repo): boolean => {
    if (!logs.has(repo.id)) logs.set(repo.id, owns(repo) || onCrew(db, repo, viewer));
    return logs.get(repo.id)!;
  };

  const out: Candidate[] = [];
  const folded = foldPulls(events);
  for (const e of events) {
    const repo = repos.get(e.repoId!);
    if (!repo) continue;
    const fold = folded.get(e.id);
    if (fold === "skip") continue;
    if (e.kind === "clog.cleared" && now - Date.parse(e.createdAt) > CLOG_NOTE_WINDOW_MS) continue;
    const c = fromEvent(db, e, repo, owns(repo), readsLogs(repo), subjects);
    if (c)
      out.push({
        ...c,
        actor: nameOf(e.actorId),
        ...(fold === undefined ? {} : { what: `${c.what} · ${foldedWords(fold, now)}` }),
      });
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
  out.push(...hotCandidates(writable));
  // A decision about a pull or a tell links to it, one tap from its diff;
  // one about nothing in particular keeps the pulls list.
  const about = getIssuesByIds(db, decided.flatMap((d) => (d.issueId === null ? [] : [d.issueId])));
  for (const d of decided) {
    const repo = repos.get(d.repoId);
    if (!repo) continue;
    const subject = d.issueId === null ? undefined : about.get(d.issueId);
    out.push({
      id: `decision:${d.id}`,
      kind: "decision",
      repoId: repo.id,
      app: slug(repo),
      actorId: null,
      actor: null,
      at: d.outcomeAt ?? d.createdAt,
      link: subject === undefined
        ? `${base(repo)}/pulls`
        : `${base(repo)}/${subject.kind === "pull" ? "pulls" : "issues"}/${subject.number}`,
      what: clip(`${d.by} chose “${clip(d.answer, 40)}” on a ${d.kind} and it ended ${d.outcome}`),
      urgency: 0,
    });
  }
  return awake(db, out, repos);
}

/** What a pull's earlier posts add to its latest: when it opened, how many reviews. */
interface Fold {
  readonly openedAt: string | undefined;
  readonly reviews: number;
}

const FOLDS = new Set(["pull.opened", "pull.reviewed", "pull.merged"]);

/**
 * One post per pull (#5808): of the window's opened, reviewed and merged
 * events for the same pull, the newest stands for them and reads by its
 * latest state; the rest are "skip". Only the newest of a folded pull has
 * an entry that is a Fold. A pull with one event in the window is unchanged.
 * A failed run is not a pull event: it keeps its own post.
 */
function foldPulls(events: readonly ForgeEvent[]): Map<string, Fold | "skip"> {
  const groups = new Map<string, ForgeEvent[]>();
  for (const e of events) {
    const n = e.payload["number"];
    if (!FOLDS.has(e.kind) || typeof n !== "number" || e.repoId === null) continue;
    const key = `${e.repoId}#${n}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }
  const out = new Map<string, Fold | "skip">();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const newest = g.reduce((a, b) =>
      b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id) ? b : a,
    );
    for (const e of g) if (e !== newest) out.set(e.id, "skip");
    out.set(newest.id, {
      openedAt: g.find((e) => e.kind === "pull.opened")?.createdAt,
      reviews: g.filter((e) => e.kind === "pull.reviewed").length,
    });
  }
  return out;
}

function foldedWords(f: Fold, now: number): string {
  return [
    ...(f.openedAt === undefined ? [] : [`opened ${ago(Date.parse(f.openedAt), now)}`]),
    ...(f.reviews === 0 ? [] : [`${f.reviews} review${f.reviews === 1 ? "" : "s"}`]),
  ].join(", ");
}

/**
 * Archived things are hidden, not gone (#1838): whatever a sleeping
 * repository did stays out of the feed until it is woken, with no other step.
 */
function awake(
  db: Database,
  candidates: Candidate[],
  known: ReadonlyMap<string, Repo>,
): Candidate[] {
  const unknown = candidates.map((c) => c.repoId).filter((id) => !known.has(id));
  const all = new Map([...known, ...getReposByIds(db, unknown)]);
  return candidates.filter((c) => all.get(c.repoId)?.archivedAt == null);
}

/** `0.7.251 is serving: <first title> and N more`, or undefined without a valid version. */
function releasePost(p: Record<string, unknown>): string | undefined {
  const version = p["version"];
  if (typeof version !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return undefined;
  const pulls = Array.isArray(p["pulls"]) ? p["pulls"] : [];
  const titles = pulls.flatMap((x) => {
    const t = (x as { title?: unknown } | null)?.title;
    return typeof t === "string" && t.trim() !== "" ? [t.trim()] : [];
  });
  if (titles.length === 0) return `${version} is serving`;
  const more = titles.length - 1;
  return `${version} is serving: ${clip(titles[0]!, 80)}${more > 0 ? ` and ${more} more` : ""}`;
}

type Partial = Omit<Candidate, "actor">;

/** The conversations the window's events name, read once for all of them. */
interface Subjects {
  issue(repoId: string, number: number): Issue | undefined;
  pull(repoId: string, number: number): Pull | undefined;
}

/** Asked-for-changes sits above plain news; an approval is news. */
const CHANGES_URGENCY = 1;

/**
 * The verdict and the reviewer's first sentence, from the review the event
 * names. A review that is gone, or one with no verdict, keeps the old words.
 */
function reviewedPost(
  db: Database,
  p: Record<string, unknown>,
  common: Omit<Partial, "what">,
  title: string,
): Partial {
  const review =
    typeof p["reviewId"] === "string" ? getReview(db, p["reviewId"]) : undefined;
  const on = title === "" ? "a pull request" : clip(title);
  if (review?.state === "approved")
    return { ...common, what: `approved ${on}` };
  if (review?.state === "changes_requested") {
    const first = firstSentence(review.body);
    return {
      ...common,
      urgency: CHANGES_URGENCY,
      what: `asked for changes on ${on}${first === "" ? "" : `: ${first}`}`,
    };
  }
  return {
    ...common,
    what: `reviewed a pull request${title ? `: ${clip(title)}` : ""}`,
  };
}

/** Up to the first sentence's end, at most 100 characters. */
function firstSentence(body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  const end = text.search(/[.!?](\s|$)/);
  return clip(end === -1 ? text : text.slice(0, end + 1), 100);
}

function fromEvent(
  db: Database,
  e: ForgeEvent,
  repo: Repo,
  ownerFacts: boolean,
  logReader: boolean,
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
  const change = number === undefined ? base(repo) : `${base(repo)}/pulls/${number}`;
  switch (e.kind) {
    case "run.finished": {
      const state = p["state"] === "failed" ? "failed" : "ok";
      const kind = typeof p["kind"] === "string" ? p["kind"] : "run";
      const cost = typeof p["costUsd"] === "number" ? p["costUsd"] : 0;
      const link = `${base(repo)}/runs/${String(p["runId"] ?? "")}`;
      const summary = clip(typeof p["summary"] === "string" ? p["summary"] : "");
      const subject = typeof p["subject"] === "number" ? ` on #${p["subject"]}` : "";
      // A log line is for writers and crew; everyone else keeps the summary.
      const kept =
        state === "failed" && logReader ? getRunErrorLine(db, String(p["runId"] ?? "")) : undefined;
      const errorLine = kept?.text ?? "";
      const errorAt = kept?.at ?? 0;
      // The line it broke at, on the run page that already holds the whole log.
      const failLink = state === "failed" && errorLine !== "" && errorAt > 0
        ? `${link}?all=1#L${errorAt}`
        : link;
      const failure = errorLine === "" ? summary : errorLine;
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
        link: failLink,
        urgency: state === "failed" ? 4 : 0,
        what: `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} run${subject} ${state === "failed" ? "failed" : "finished"}${state === "failed" ? (failure ? `: ${failure}` : "") : summary ? `: ${summary}` : ""}`,
      };
    }
    case "pull.opened":
      return { ...common, kind: "pull", link: change, what: `opened a pull request${title ? `: ${clip(title)}` : ""}${toldWords}` };
    case "pull.merged":
      return { ...common, kind: "pull", link: change, what: `merged a pull request${title ? `: ${clip(title)}` : ""}${toldWords}` };
    case "pull.reviewed":
      return reviewedPost(db, p, { ...common, kind: "pull", link: change }, title);
    case "look.taken": {
      const env = p["env"];
      const oid = p["commitOid"];
      if (typeof env !== "string" || !isEnvName(env))
        return { ...common, kind: "look", link: base(repo), what: "a new picture of it is ready" };
      const of = env === "production" ? "production" : `#${env.slice("pull-".length)}`;
      return {
        ...common,
        kind: "look",
        link: env === "production" ? base(repo) : `${base(repo)}/pulls/${env.slice("pull-".length)}`,
        what: `a new picture of ${of}`,
        ...(typeof oid === "string" && /^[0-9a-f]{40}$/.test(oid) ? { look: { env, commitOid: oid } } : {}),
      };
    }
    case "app.serving": {
      const post = releasePost(p);
      if (post === undefined)
        return { ...common, kind: "release", link: base(repo), what: "a new version is serving" };
      const oid = p["commitOid"];
      return {
        ...common,
        kind: "release",
        link: typeof oid === "string" && /^[0-9a-f]{40}$/.test(oid) ? `${base(repo)}/commit/${oid}` : base(repo),
        what: post,
      };
    }
    // A tell is a post; a comment is a reply under it, in its own words.
    case "issue.opened": {
      if (number === undefined) return undefined;
      const told = subjects.issue(repo.id, number)?.title ?? "";
      return {
        ...common,
        kind: "tell",
        link: `${base(repo)}/issues/${number}`,
        what: `opened an issue: ${told === "" ? `#${number}` : clip(told)}`,
        fold: { group: "issues", title: told === "" ? `#${number}` : clip(told) },
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
      // The comment itself: past the newest window it is behind `?all=1`.
      const thread = subjects.issue(repo.id, number);
      const commentId = p["commentId"];
      const anchor =
        thread !== undefined && typeof commentId === "string"
          ? commentAnchor(db, thread.id, commentId)
          : "";
      return {
        ...common,
        kind: "reply",
        link:
          (e.kind === "issue.commented"
            ? `${base(repo)}/issues/${number}`
            : change) + anchor,
        what: said === "" ? `replied on “${on}”` : `on “${on}”: ${clip(said)}`,
      };
    }
    case "clog.cleared": {
      const note = typeof p["note"] === "string" ? p["note"] : "";
      if (note === "") return undefined;
      const what = clip(flattenNote(note), 300);
      return { ...common, kind: "map", link: base(repo), what, said: what };
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
    case "crew.governed":
      return {
        ...common,
        kind: "map",
        link: `${base(repo)}/map`,
        what: clip(typeof p["why"] === "string" ? p["why"] : "the crew's slots changed"),
      };
    default:
      return undefined;
  }
}
