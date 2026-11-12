/**
 * The thought stream (#653): every thought a person sent, newest first, each
 * with where the planner put it and one state word read from what became of
 * the issues it placed. `unplaced` until the planner reaches it; `placed`
 * once it has; `building` while a pull or a run is open on a placed issue;
 * `shipped` once a pull closing one merged; `superseded` when a later
 * thought marked what it placed superseded — and then it says which.
 *
 * Flagged: nothing merged N days after placement (after receipt, while still
 * unplaced). N is the person's `thoughtFlagDays` setting, three by default.
 * A thought that asked for nothing to be built (a vision, a decision, a
 * deferral) is never flagged. Everything is derived on read from the
 * thought, placement, issue, pull and run tables; a thought belongs to its
 * author, and a placement link to a repository the viewer cannot read is
 * not shown.
 */

import type { Database } from "bun:sqlite";
import { pullsByAsk } from "./asked.ts";
import { getIssue } from "./issues.ts";
import { placementsOf, type Kind, type Placed } from "./placements.ts";
import { canRead, getRepo, type Repo } from "./repos.ts";
import { listActiveRuns } from "./runs.ts";
import { getUserSetting } from "./settings.ts";
import { linksFrom, linksTo } from "./thought_links.ts";
import { recentThoughts, thoughtOf } from "./thoughts.ts";
import type { User } from "./users.ts";

export type ThoughtState = "unplaced" | "placed" | "building" | "shipped" | "superseded";

export const FLAG_DAYS = 3;
/** The user setting that holds a person's overrule of one note. */
export const overruleKey = (thoughtId: string): string => `note.${thoughtId}`;
export const FLAG_DAYS_KEY = "thoughtFlagDays";
export const THOUGHT_LIMIT = 200;

const DAY = 24 * 60 * 60 * 1000;

/** One issue a thought placed, with its title when the viewer may read it. */
export interface PlacedLink extends Placed {
  /** False when the viewer cannot read the repository: nothing about it is shown. */
  readonly readable: boolean;
  readonly title: string | null;
  readonly issueState: "open" | "closed" | null;
  /** The pulls that close it, and whether a run is on it now (what a note's one line reads). */
  readonly pulls: readonly { readonly number: number; readonly state: "open" | "merged" | "closed" }[];
  readonly running: boolean;
}

export interface StreamThought {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly receivedAt: string;
  readonly kind: Kind | null;
  readonly reply: string | null;
  /** The planner's reply is a question back to the person, not a placement. */
  readonly asked: boolean;
  readonly placedAt: string | null;
  readonly placed: readonly PlacedLink[];
  readonly state: ThoughtState;
  readonly flagged: boolean;
  /** What the person said against the planner's verdict (#8696), if they did. */
  readonly overruled: "accepted" | "declined" | null;
  /** The later thought that superseded this one. */
  readonly supersededBy: { readonly id: string; readonly text: string; readonly receivedAt: string } | null;
  /** The earlier thought this one says again (#654). */
  readonly repeats: ThoughtRef | null;
  /** The earlier thoughts this one takes back. */
  readonly supersedes: readonly ThoughtRef[];
}

export interface ThoughtRef {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
}

/** A person's flag window in days: their setting when it is a whole number of 1–90, else three. */
export function flagDays(db: Database, userId: string): number {
  const n = Number(getUserSetting(db, userId, FLAG_DAYS_KEY));
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : FLAG_DAYS;
}

const keyOf = (p: Placed) => `${p.repo}#${p.number}`;
export const BUILDS = new Set(["opened", "amended", "linked"]);

export function thoughtStream(
  db: Database,
  viewer: User,
  options: { days?: number; now?: Date; limit?: number } = {},
): StreamThought[] {
  const days = options.days ?? flagDays(db, viewer.id);
  const now = (options.now ?? new Date()).getTime();
  const limit = Math.min(Math.max(options.limit ?? THOUGHT_LIMIT, 1), THOUGHT_LIMIT);
  const thoughts = recentThoughts(db, viewer.id, limit);
  const placements = placementsOf(db, thoughts.map((t) => t.id));

  // Every repository the placements name, once.
  const repos = new Map<string, Repo | undefined>();
  const repoOf = (slug: string): Repo | undefined => {
    if (!repos.has(slug)) {
      const [owner, name, ...rest] = slug.split("/");
      const r = owner && name && rest.length === 0 ? getRepo(db, owner, name) : undefined;
      // A repository the viewer cannot read is a repository that is not there.
      repos.set(slug, r && canRead(db, r, viewer) ? r : undefined);
    }
    return repos.get(slug);
  };
  const pulls = new Map<string, ReturnType<typeof pullsByAsk>>();
  const pullsOf = (repo: Repo) => {
    let m = pulls.get(repo.id);
    if (m === undefined) pulls.set(repo.id, (m = pullsByAsk(db, [repo.id])));
    return m;
  };
  // Resolve every repository first, then read the crew's active runs once.
  for (const p of placements.values()) for (const x of p.placed) repoOf(x.repo);
  const activeRuns = new Set(
    listActiveRuns(db, [...repos.values()].flatMap((r) => (r ? [r.id] : []))).flatMap((r) =>
      r.issueId === null ? [] : [r.issueId],
    ),
  );

  // Who superseded what: the first later thought that marked an issue superseded.
  const supersedes = new Map<string, (typeof thoughts)[number]>();
  for (const t of [...thoughts].reverse()) {
    for (const x of placements.get(t.id)?.placed ?? [])
      if (x.action === "superseded" && repoOf(x.repo) !== undefined && !supersedes.has(keyOf(x))) supersedes.set(keyOf(x), t);
  }

  // Links the planner wrote: the later thought wins, whatever the issues did.
  const byId = new Map(thoughts.map((t) => [t.id, t]));
  const ref = (id: string): ThoughtRef | null => {
    const t = byId.get(id) ?? thoughtOf(db, viewer.id, id);
    return t ? { id: t.id, text: t.text, receivedAt: t.receivedAt } : null;
  };

  const overrules = new Map(
    db
      .query<{ key: string; value: string }, [string]>("SELECT key, value FROM user_setting WHERE user_id = ?1 AND key LIKE 'note.%'")
      .all(viewer.id)
      .map((r) => [r.key, r.value]),
  );
  return thoughts.map((t) => {
    const p = placements.get(t.id);
    const from = linksFrom(db, t.id);
    const to = linksTo(db, t.id);
    const links: PlacedLink[] = (p?.placed ?? []).map((x) => {
      const repo = repoOf(x.repo);
      const issue = repo ? getIssue(db, repo.id, x.number) : undefined;
      const its = repo ? (pullsOf(repo).get(`${repo.id}#${x.number}`) ?? []) : [];
      return {
        ...x,
        readable: repo !== undefined,
        title: issue?.title ?? null,
        issueState: issue?.state ?? null,
        pulls: its.map((q) => ({ number: q.number, state: q.state })),
        running: issue !== undefined && activeRuns.has(issue.id),
      };
    });
    let built = false;
    let shipped = false;
    let building = false;
    let by: (typeof thoughts)[number] | undefined;
    for (const x of p?.placed ?? []) {
      if (!BUILDS.has(x.action)) continue;
      built = true;
      const repo = repoOf(x.repo);
      const issue = repo ? getIssue(db, repo.id, x.number) : undefined;
      if (repo === undefined || issue === undefined) continue;
      const its = pullsOf(repo).get(`${repo.id}#${x.number}`) ?? [];
      if (its.some((q) => q.state === "merged")) shipped = true;
      else if (its.some((q) => q.state === "open") || activeRuns.has(issue.id)) building = true;
      const s = supersedes.get(keyOf(x));
      if (s !== undefined && s.id !== t.id && s.receivedAt >= t.receivedAt) by = s;
    }
    const linked = to.supersededBy === null ? null : ref(to.supersededBy);
    if (by === undefined && linked) by = { ...t, id: linked.id, text: linked.text, receivedAt: linked.receivedAt, source: "" };
    const state: ThoughtState =
      p === undefined ? "unplaced"
      : by !== undefined && !shipped ? "superseded"
      : shipped ? "shipped"
      : building ? "building"
      : "placed";
    const since = Date.parse(p?.placedAt ?? t.receivedAt);
    const flagged =
      (state === "unplaced" || (state === "placed" && built)) && now - since > days * DAY;
    return {
      id: t.id,
      text: t.text,
      source: t.source,
      receivedAt: t.receivedAt,
      kind: p?.kind ?? null,
      reply: p?.reply ?? null,
      asked: p?.asked ?? false,
      placedAt: p?.placedAt ?? null,
      placed: links,
      state,
      flagged,
      overruled: ((v) => (v === "accepted" || v === "declined" ? v : null))(overrules.get(overruleKey(t.id))),
      supersededBy:
        state === "superseded" && by ? { id: by.id, text: by.text, receivedAt: by.receivedAt } : null,
      repeats: from.repeats[0] ? ref(from.repeats[0]) : null,
      supersedes: from.supersedes.flatMap((id) => ref(id) ?? []),
    };
  });
}

/** The row as JSON, for the MCP: the text verbatim. */
export function streamJson(t: StreamThought) {
  return {
    id: t.id,
    text: t.text,
    source: t.source,
    receivedAt: t.receivedAt,
    kind: t.kind,
    reply: t.reply,
    placedAt: t.placedAt,
    placed: t.placed.map((x) =>
      x.readable
        ? { action: x.action, repo: x.repo, number: x.number, title: x.title, ...(x.pull === undefined ? {} : { pull: x.pull }) }
        : { action: x.action, repo: null, number: null, title: null },
    ),
    state: t.state,
    flagged: t.flagged,
    supersededBy: t.supersededBy,
    repeats: t.repeats,
    supersedes: t.supersedes,
  };
}
