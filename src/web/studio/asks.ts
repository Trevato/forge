/**
 * What asks a person, and what they can do about it: a *decision* is one
 * card — a pull the crew stopped on, a green pull waiting for a look, or a
 * repository parked at its ceiling — read from the same tables the rest of
 * the forge reads, with the same access the owner has. This module owns the
 * card, the row and the panel of them; every button here posts
 * to the route a person could have posted to by hand (`actions.ts`).
 */

import type { Database } from "bun:sqlite";
import { previewEnv } from "../../apps/data.ts";
import { crewForRepos } from "../../core/agents.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { appsForRepos, getAppByRepo, listApps } from "../../core/apps.ts";
import { latestDecision, stopStands } from "../../core/decisions.ts";
import { askDismissals } from "../../core/interactions.ts";
import { askMeasure, syncAskLedger, type AskEnd } from "../../core/ask_ledger.ts";
import {
  getIssueById,
  labelsForIssues,
  listComments,
  listOpenPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import { looksForApps } from "../../core/looks.ts";
import { closesFromBody, joinMany, type Pull } from "../../core/pulls.ts";
import {
  listReposVisibleTo,
  listReposWritableTo,
  ownerFactRepoIds,
  type Repo,
} from "../../core/repos.ts";
import { listReviews } from "../../core/reviews.ts";
import {
  activeRunFor,
  automaticRunsSince,
  latestRunsForIssues,
} from "../../core/runs.ts";
import { getUserById, type User } from "../../core/users.ts";
import {
  isPausedAtCeiling,
  plannerDeclines,
  spentTodayForRepos,
} from "../../crew/autonomy.ts";
import { breakerParked } from "../../crew/breaker.ts";
import { CHECK_FAILED_LIMIT } from "../../crew/dispatch.ts";
import { isStalePull } from "../../crew/stale_asks.ts";
import type { Ctx } from "../../http/context.ts";
import { vitals } from "../../kernel/vitals.ts";
import { repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { btn, card, icon, row } from "../ui.ts";
import { lookThumb, lookUrl, thumbLook } from "../pages/looks.ts";
import { changeHref } from "./nouns.ts";

/** Repos narrowed to those with an app record, with the records — the one
 * join `appsOf` and `writableAppsOf` share. */
function appsFiltered(
  ctx: Ctx,
  repos: readonly Repo[],
): { repos: Repo[]; records: ReturnType<typeof appsForRepos> } {
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  return { repos: repos.filter((r) => records.has(r.id)), records };
}

/** The apps a person can see, as repositories, with their records — the
 * same visibility a signed-out reader gets from `listReposVisibleTo` too.
 * Everyone's public apps sit in this list beside the viewer's own: right
 * for search, the palette and the asks count, wrong for a shelf headed
 * "your apps" — that reading is `writableAppsOf`. */
export function appsOf(ctx: Ctx, user: User | undefined) {
  return appsFiltered(
    ctx,
    listReposVisibleTo(ctx.app.db, user, { limit: 200 }),
  );
}

/** The apps a person can write — their own, or their organisations' — as
 * repositories, with their records. This is "your apps": the studio home's
 * shelf and its cost line, never widened by what a stranger merely made
 * public. */
export function writableAppsOf(ctx: Ctx, user: User | undefined) {
  return appsFiltered(
    ctx,
    listReposWritableTo(ctx.app.db, user, { limit: 200 }),
  );
}

export type DecisionKind = "stopped" | "look" | "paused" | "parked" | "declined";

/** Dollars as a person reads them: cents when small, whole when not. */
const dollars = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(0));

export interface Decision {
  readonly kind: DecisionKind;
  /** Stable across renders — the kind and what it is about — so a form can
   * name it and a later request can find it again. */
  readonly id: string;
  readonly repo: Repo;
  readonly pull?: Pull | undefined;
  /** For "parked": the issue the breaker stopped; for "declined": the
   * direction issue the planner declined. */
  readonly issue?: Issue | undefined;
  readonly who: string;
  /** Three sentences at most: what, why, what happens next. */
  readonly says: string;
  /** The same in one clause, for a row. */
  readonly short: string;
  /** The option the decider thinks is right, and how sure; none for a rule. */
  readonly likely?: { readonly option: string; readonly p: number } | undefined;
  /** The preview pictured on a phone, when the forge has taken one. */
  readonly picture?: string | undefined;
  readonly consequence: Consequence;
}

/** What an ask asks, the answers it takes, and what happens if nobody gives one. */
export interface AskWords {
  readonly decision: string;
  readonly options: readonly string[];
  readonly ifNothing: string;
}

/** The words for each kind of ask: every ask names its decision, its options and its default. */
export const ASK_WORDS: Readonly<Record<DecisionKind, AskWords>> = {
  look: {
    decision: "Ship this change?",
    options: ["Ship", "Say what is off"],
    ifNothing: "it waits; nothing ships",
  },
  stopped: {
    decision: "The check fails and the crew stopped: what should it try?",
    options: ["Tell them what to try", "Close it"],
    ifNothing: "it stays red; the crew tries nothing more",
  },
  parked: {
    decision: "What should the crew try next?",
    options: ["Tell them"],
    ifNothing: "nothing more starts on it",
  },
  declined: {
    decision: "The planner declined the direction: answer it?",
    options: ["Answer the planner"],
    ifNothing: "the planner plans nothing more for this app",
  },
  paused: {
    decision: "Raise today's ceiling?",
    options: ["Raise it in settings"],
    ifNothing: "the crew starts again at 00:00 UTC",
  },
};

/**
 * How much an ask matters, as a score and the reason: security first, then
 * money, then what holds other work up, then the rest by kind — and, inside
 * a tier, the older first (the age part stays under 1, so it never crosses
 * a tier). `consequenceOf` is the one place this order is decided.
 */
export interface Consequence {
  readonly score: number;
  readonly why: string;
}

const SECURITY = /\bsecurity\b|\bvulnerab|\bleak/i;

/** The tier of a kind when nothing about the thing itself says more. */
export const KIND_TIER: Readonly<Record<DecisionKind, Consequence>> = {
  paused: { score: 80, why: "money: the crew is stopped at its ceiling" },
  declined: { score: 70, why: "the planner has stopped for this app" },
  stopped: { score: 50, why: "red, and the crew stopped" },
  parked: { score: 40, why: "parked by the crew" },
  look: { score: 30, why: "green, waiting" },
};

/** When a person last spoke on a conversation, or its start. */
function lastHumanWord(db: Database, issue: Issue, agentName: string): string {
  let latest = issue.createdAt;
  for (const c of listComments(db, issue.id))
    if (c.authorName !== agentName && c.createdAt > latest)
      latest = c.createdAt;
  for (const r of listReviews(db, issue.id))
    if (r.authorName !== agentName && r.createdAt > latest)
      latest = r.createdAt;
  return latest;
}

/**
 * A candidate ask, classified but not yet worded or pictured: the set
 * `decisionsFor` and `askCountFor` both build from, so a count can never
 * disagree with the list it is a count of.
 */
interface AskCandidate {
  readonly kind: DecisionKind;
  /** The ask's own id, `kind:what` (see `Decision.id`). */
  readonly id: string;
  /** When its cause last changed: a dismissal before this no longer holds. */
  readonly since: string;
  readonly repo: Repo;
  readonly pull?: Pull;
  readonly issue?: Issue;
  readonly who: string;
  /** Whether the author is a crew member — a "look" card words itself
   * differently for a person's own change than for the crew's (below).
   * Absent for "paused", which names no author at all. */
  readonly authorIsAgent?: boolean;
  /** For "stopped": how many automatic tries, and whether the decider itself stopped it. */
  readonly tries?: number;
  readonly stoppedByDecider?: boolean;
  /** For "declined": the declining run and what the planner said. */
  readonly decline?: { readonly runId: string; readonly words: string };
}

/**
 * Open pulls the viewer may land, sorted into what asks them: stopped (red
 * past the crew's own limit since a person last spoke — the crew's own
 * pulls only, since only the crew retries automatically), or green and
 * waiting for a look, whoever opened it. Plus a repository paused at its
 * ceiling. Every read here is bounded by the pulls a person can see or the
 * repositories handed in — never by a loop that queries once per app: the
 * ceiling check reads spend and crew for every repository in one query
 * each (`spentTodayForRepos`, `crewForRepos`), not `autonomyStatus` per
 * repository.
 */
function askCandidatesFor(
  db: Database,
  user: User | undefined,
  allRepos: readonly Repo[],
): AskCandidate[] {
  const out: AskCandidate[] = [];
  if (!user) return out;
  // Shipping, closing and the day's ceiling are the owner's own decisions —
  // a reader who cannot write here is never asked to make one, and never
  // sees the dollar figure a "paused" card would otherwise carry.
  const ownerFacts = ownerFactRepoIds(db, allRepos, user);
  const repos = allRepos.filter((r) => ownerFacts.has(r.id));
  const byId = new Map(repos.map((r) => [r.id, r]));
  const pulls = listOpenPullsVisibleTo(db, user, 50).filter((p) =>
    byId.has(p.repoId),
  );
  const checks = latestRunsForIssues(
    db,
    pulls.map((p) => p.id),
  );
  const joined = new Map(joinMany(db, pulls).map((p) => [p.id, p]));
  for (const issue of pulls) {
    const repo = byId.get(issue.repoId)!;
    const pull = joined.get(issue.id);
    if (!pull) continue;
    const check = checks.get(issue.id);
    const who = issue.authorName;
    // The crew is on it: that is working, not a question for a person.
    if (activeRunFor(db, "agent", issue.id) !== undefined) continue;
    if (check?.state === "failed") {
      // Automatic retries, and the limit that stops them, are the crew's
      // own machinery — a person's own failing pull never accrues tries,
      // so it never earns a "stopped" card; it just stays waiting.
      if (!issue.authorIsAgent) continue;
      const since = lastHumanWord(db, issue, who);
      const tries = automaticRunsSince(db, issue.id, since);
      const stopped = stopStands(latestDecision(db, issue.id, "retry"));
      // A repository on its own parks what it cannot finish and moves on;
      // only an assisted one stops here for a person.
      if (
        (tries >= CHECK_FAILED_LIMIT || stopped) &&
        repo.autonomy !== "autonomous"
      )
        out.push({
          kind: "stopped",
          id: `stopped:${pull.id}`,
          since: check.createdAt,
          repo,
          pull,
          who,
          authorIsAgent: true,
          tries,
          stoppedByDecider: stopped,
        });
    } else if (
      check?.state === "ok" &&
      repo.autonomy !== "autonomous" &&
      // A green pull that no longer merges as it stands cannot be shipped:
      // bringing it up to date is work, not a person's decision.
      !isStalePull(db, pull.id, pull.headOid)
    ) {
      // Autonomous repositories look at their own green pulls: the decider,
      // then the crew's reviewer. Everything else waits for a person —
      // whoever opened it, since a green change asks to be looked at
      // whether the crew wrote it or a person did.
      out.push({
        kind: "look",
        id: `look:${pull.id}`,
        since: check.createdAt,
        repo,
        pull,
        who,
        authorIsAgent: issue.authorIsAgent,
      });
    }
  }
  const crew = crewForRepos(
    db,
    repos.map((r) => r.id),
  );
  const spent = spentTodayForRepos(
    db,
    repos.map((r) => r.id),
  );
  // Only a ceiling pause is an ask — "nobody" and "no crew" are settings
  // problems, not a decision, so neither needs its own card.
  // A ceiling pause is today's: tomorrow it is a new one.
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  for (const repo of repos)
    if (isPausedAtCeiling(repo, crew, spent))
      out.push({
        kind: "paused",
        id: `paused:${repo.id}`,
        since: today,
        repo,
        who: "the crew",
      });
  // An issue the breaker parked waits for a person's word.
  for (const p of breakerParked(
    db,
    repos.map((r) => r.id),
  )) {
    const issue = getIssueById(db, p.issueId);
    const repo = byId.get(p.repoId);
    if (issue && repo)
      out.push({
        kind: "parked",
        id: `parked:${issue.id}`,
        since: p.at,
        repo,
        issue,
        who: "the crew",
      });
  }
  // A planner that declined the direction plans nothing more until a person
  // answers on the direction issue: the crew has gone quiet on purpose.
  for (const d of plannerDeclines(db, repos))
    out.push({
      kind: "declined",
      // The run, not the issue: each new decline is new, and pages once.
      id: `declined:${d.runId}`,
      since: d.at,
      repo: d.repo,
      issue: d.issue,
      who: "the planner",
      decline: { runId: d.runId, words: d.words },
    });
  return out;
}

/**
 * Score each candidate (`Consequence`). Labels and blocked work are read
 * once for the whole set, never per row.
 */
function consequencesOf(
  db: Database,
  asks: readonly AskCandidate[],
  now: number,
): Map<string, Consequence> {
  const things = asks.map((a) => a.pull ?? a.issue).filter((t) => t !== undefined);
  const labels = labelsForIssues(
    db,
    things.map((t) => t.id),
  );
  const blocks = db.query<{ n: number }, [string, string]>(
    `SELECT COUNT(*) AS n FROM issue_dependency d JOIN issue i ON i.id = d.blocked_by_id
     JOIN issue w ON w.id = d.issue_id
     WHERE i.repo_id = ?1 AND w.state = 'open' AND i.number IN (SELECT value FROM json_each(?2))`,
  );
  const out = new Map<string, Consequence>();
  for (const a of asks) {
    const thing = a.pull ?? a.issue;
    const age = Math.min(
      Math.max(0, (now - Date.parse(a.since)) / 86_400_000),
      9.9,
    ) / 10;
    let c = KIND_TIER[a.kind];
    if (thing !== undefined) {
      const security =
        SECURITY.test(thing.title) ||
        (labels.get(thing.id) ?? []).some((l) => /security/i.test(l.name));
      // What the thing would close, and what waits for that.
      const numbers = a.pull ? closesFromBody(a.pull.body) : [thing.number];
      const waiting =
        numbers.length === 0
          ? 0
          : (blocks.get(a.repo.id, JSON.stringify(numbers))?.n ?? 0);
      if (security) c = { score: 100, why: "security" };
      else if (waiting > 0 && c.score < 60)
        c = {
          score: 60,
          why: `${waiting} other ${waiting === 1 ? "issue waits" : "issues wait"} for it`,
        };
    }
    out.set(a.id, { score: c.score + age, why: c.why });
  }
  return out;
}

/** The row an ask collapses into: one kind in one repository. */
const groupId = (a: { kind: DecisionKind; repo: Repo }): string =>
  `${a.kind}:${a.repo.id}`;

/**
 * The asks the viewer has not set aside: a dismissal — of the ask, or of
 * the row it collapsed into — holds until the ask's cause is newer than it
 * (a check ran again, it was parked again, a new day's pause).
 */
function notDismissed<T extends AskCandidate>(
  db: Database,
  user: User,
  asks: readonly T[],
): T[] {
  const dismissed = askDismissals(db, user.id);
  if (dismissed.size === 0) return [...asks];
  const holds = (id: string, since: string): boolean =>
    (dismissed.get(`ask:${id}`) ?? "") > since;
  return asks.filter(
    (a) => !holds(a.id, a.since) && !holds(groupId(a), a.since),
  );
}

/** Asks as the rows a person sees: the same kind in the same repository is one. */
export interface AskRow<T> {
  /** The ask's own id when it is alone, else the row's (`kind:repoId`). */
  readonly id: string;
  readonly kind: DecisionKind;
  readonly repo: Repo;
  readonly items: readonly T[];
  /** The weightiest ask's: what the row ranks by. */
  readonly consequence: Consequence;
}

/**
 * Asks as rows, most consequential first: a row ranks by its weightiest
 * ask, and the asks inside it the same way.
 */
export function askRows<
  T extends { id: string; kind: DecisionKind; repo: Repo; consequence: Consequence },
>(
  unranked: readonly T[],
): AskRow<T>[] {
  const asks = [...unranked].sort(
    (a, b) => b.consequence.score - a.consequence.score,
  );
  const rows = new Map<string, T[]>();
  for (const a of asks) {
    const key = groupId(a);
    const row = rows.get(key);
    if (row) row.push(a);
    else rows.set(key, [a]);
  }
  return [...rows.entries()].map(([key, items]) => ({
    id: items.length === 1 ? items[0]!.id : key,
    kind: items[0]!.kind,
    repo: items[0]!.repo,
    items,
    consequence: items[0]!.consequence,
  }));
}

type Scored = AskCandidate & { readonly consequence: Consequence };

/** Every candidate for the viewer, scored, dismissed or not. */
function scoredFor(
  db: Database,
  user: User | undefined,
  repos: readonly Repo[],
  now = Date.now(),
): Scored[] {
  const asks = askCandidatesFor(db, user, repos);
  const scores = consequencesOf(db, asks, now);
  return asks.map((a) => ({ ...a, consequence: scores.get(a.id)! }));
}

/** What asks the viewer now: candidates, less what they set aside. */
function waitingOn(
  db: Database,
  user: User | undefined,
  repos: readonly Repo[],
): Scored[] {
  if (!user) return [];
  return notDismissed(db, user, scoredFor(db, user, repos));
}

/** How an ask that is no longer asked ended, when nobody dismissed it. */
function endOf(db: Database, askId: string, raisedAt: string): Exclude<AskEnd, "dismissed"> {
  const [kind, what] = askId.split(":") as [DecisionKind, string];
  if (kind === "look" || kind === "stopped") {
    const pull = getIssueById(db, what);
    // Shipped or closed: someone decided. Still open: the cause went away.
    return pull !== undefined && pull.state !== "open" ? "acted" : "expired";
  }
  if (kind === "parked") {
    const issue = getIssueById(db, what);
    if (issue === undefined) return "expired";
    if (issue.state !== "open") return "acted";
    const spoke = listComments(db, issue.id).some(
      (c) => c.createdAt > raisedAt && getUserById(db, c.authorId)?.kind === "user",
    );
    return spoke ? "acted" : "expired";
  }
  // A pause lifted the same day was a raised ceiling; a decline that ends
  // was answered (the planner only goes on after a person's word).
  if (kind === "paused")
    return raisedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ? "acted"
      : "expired";
  return "acted";
}

/**
 * Bring the asks ledger (`core/ask_ledger.ts`) in line with what asks each
 * person who came to the forge lately — a signed-in session that has not
 * expired, or a phone to tell. A tick's work, never a request's.
 */
export function recordAskLedger(db: Database, now = new Date()): void {
  const at = now.toISOString();
  const people = db
    .query<{ id: string }, [string]>(
      `SELECT DISTINCT u.id AS id FROM user u
       WHERE u.is_agent = 0 AND u.kind = 'user' AND (
         EXISTS (SELECT 1 FROM session s WHERE s.user_id = u.id AND s.expires_at > ?1)
         OR EXISTS (SELECT 1 FROM user_setting t WHERE t.user_id = u.id AND t.key = 'notify_url' AND t.value <> ''))
       LIMIT 200`,
    )
    .all(at);
  for (const { id } of people) {
    const user = getUserById(db, id);
    if (!user) continue;
    const repos = listReposVisibleTo(db, user, { limit: 200 });
    const all = scoredFor(db, user, repos, now.getTime());
    const shown = notDismissed(db, user, all);
    const brief = (a: Scored) => ({ id: a.id, repoId: a.repo.id, kind: a.kind });
    syncAskLedger(
      db,
      user.id,
      all.map(brief),
      shown.map(brief),
      (askId, raisedAt) => endOf(db, askId, raisedAt),
      at,
    );
  }
}

/** One ask in a line, without its repository's name (the row adds that). */
function lineOf(c: AskCandidate): string {
  if (c.kind === "paused") return "is paused at its ceiling";
  if (c.kind === "parked")
    return `the crew parked #${c.issue!.number} after three failed runs`;
  if (c.kind === "declined")
    return "the planner declined the direction and waits for you";
  const title = c.pull?.title ?? "";
  return c.kind === "stopped"
    ? `the crew stopped on "${title}"`
    : `"${title}" is green, waiting for your look`;
}

/** A collapsed row in a line: how many, and of what. */
function rowLine(kind: DecisionKind, n: number): string {
  if (kind === "parked")
    return `the crew parked ${n} issues after three failed runs`;
  if (kind === "declined") return `the planner declined ${n} times and waits for you`;
  if (kind === "stopped") return `the crew stopped on ${n} changes`;
  return `${n} green changes wait for your look`;
}

/** The anchor a row's card carries on `/asks`, so a link can land on it. */
export const askAnchor = (id: string): string => id.replace(/[^a-z0-9-]/g, "-");

/**
 * What asks `user` right now, one row each — the panel's own candidates
 * (same visibility, same bounds, less what they dismissed), collapsed the
 * way the page collapses them, without the pictures. `items` are the ids
 * of the asks a row holds: what the phone's notifier compares from one
 * moment to the next, so a new ask under an old row is still news.
 */
export function askLinesFor(
  db: Database,
  user: User,
): {
  id: string;
  line: string;
  kind: DecisionKind;
  repoId: string;
  /** Where a person decides it: the pull or issue, or the row on `/asks`. */
  link: string;
  /** The pull's or issue's number, for a row of one that is about one. */
  number?: number;
  items: string[];
  /** The decision, its options and what happens if nobody acts (`ASK_WORDS`). */
  words: AskWords;
  /** Why it ranks where it does; rows come most consequential first. */
  consequence: Consequence;
}[] {
  const repos = listReposVisibleTo(db, user, { limit: 200 });
  return askRows(waitingOn(db, user, repos)).map((row) => {
    const base = `/${row.repo.ownerName}/${row.repo.name}`;
    const about = {
      id: row.id,
      kind: row.kind,
      repoId: row.repo.id,
      items: row.items.map((c) => c.id),
      words: ASK_WORDS[row.kind],
      consequence: row.consequence,
    };
    const only = row.items.length === 1 ? row.items[0]! : undefined;
    if (only === undefined)
      return {
        ...about,
        line: `${row.repo.name}: ${rowLine(row.kind, row.items.length)}`,
        link: `/asks#${askAnchor(row.id)}`,
      };
    const line = `${row.repo.name}${only.kind === "paused" ? " " : ": "}${lineOf(only)}`;
    if (only.kind === "paused")
      return { ...about, line, link: `${base}/settings/autonomy` };
    if (only.kind === "parked" || only.kind === "declined")
      return {
        ...about,
        line,
        number: only.issue!.number,
        link: `${base}/issues/${only.issue!.number}`,
      };
    return {
      ...about,
      line,
      number: only.pull!.number,
      link: `${base}/changes/${only.pull!.number}`,
    };
  });
}

/**
 * The decisions waiting on the viewer, worded and pictured. A change's own
 * page passes `evenDismissed`: setting an ask aside quiets the lists, never
 * the decision on the thing itself.
 */
export function decisionsFor(
  ctx: Ctx,
  allRepos: readonly Repo[],
  options: { evenDismissed?: boolean } = {},
): Decision[] {
  const db = ctx.app.db;
  const candidates = options.evenDismissed
    ? scoredFor(db, ctx.auth.user, allRepos)
    : waitingOn(db, ctx.auth.user, allRepos);
  // The pictures, in one read: a green pull's row leads with its preview.
  const repoIds = [...new Set(candidates.map((c) => c.repo.id))];
  const records = appsForRepos(db, repoIds);
  const looks = looksForApps(
    db,
    [...records.values()].map((r) => r.id),
  );
  const pictureOf = (repo: Repo, pull: Pull): string | undefined => {
    const record = records.get(repo.id);
    if (record === undefined) return undefined;
    const env = previewEnv(pull.number);
    const look = thumbLook(
      looks.filter((l) => l.appId === record.id && l.env === env),
    );
    return (
      look && lookUrl(repoBase(repo), env, look.commitOid, look.page, look.kind)
    );
  };
  const worded = (c: Scored): Omit<Decision, "consequence"> => {
    if (c.kind === "parked" && c.issue)
      return {
        kind: "parked",
        id: `parked:${c.issue.id}`,
        repo: c.repo,
        issue: c.issue,
        who: c.who,
        says: `Three runs on #${c.issue.number} failed or were declined within an hour, so the crew parked it. Say what to try and it starts again.`,
        short: `#${c.issue.number} parked after three failed runs`,
      };
    if (c.kind === "declined" && c.issue && c.decline)
      return {
        kind: "declined",
        id: `declined:${c.decline.runId}`,
        repo: c.repo,
        issue: c.issue,
        who: c.who,
        says: `The planner declined the direction: \u201c${c.decline.words}\u201d. It plans nothing more until you answer on #${c.issue.number}.`,
        short: `the planner declined: ${c.decline.words}`,
      };
    if (c.kind === "stopped" && c.pull) {
      const tries = c.tries ?? 0;
      const stopped = c.stoppedByDecider ?? false;
      return {
        kind: "stopped",
        id: `stopped:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: stopped
          ? `${c.who}'s check failed and the crew's decider stopped rather than spend another run. Say what to try, or close it.`
          : `${c.who} tried ${tries + 1} times and the check still fails. The crew stopped here. Say what to try, or close it.`,
        short: stopped
          ? `the check failed; the decider stopped for you`
          : `${c.who} tried ${tries + 1} times; the check still fails`,
      };
    }
    if (c.kind === "look" && c.pull) {
      const picture = pictureOf(c.repo, c.pull);
      // The crew's own words say who finished it; a person's own change
      // gets the wording that is true of it — nobody "finished" it for
      // them, it is simply green and waiting.
      return {
        kind: "look",
        id: `look:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: c.authorIsAgent
          ? `${c.who} finished "${c.pull.title}" and the check is green. Look at the preview, then ship it or say what is off.`
          : `"${c.pull.title}" is green — ready for a look. Ship it, or say what is off.`,
        short: c.authorIsAgent
          ? `${c.who} finished it; the check is green`
          : `green — ready for a look`,
        ...(picture === undefined ? {} : { picture }),
      };
    }
    return {
      kind: "paused",
      id: `paused:${c.repo.id}`,
      repo: c.repo,
      who: "the crew",
      says: `${c.repo.name} reached its $${dollars(c.repo.autonomyCeilingUsd)} for today. The crew picks nothing more until 00:00 UTC. Raise the ceiling in settings to go on now.`,
      short: `at its $${dollars(c.repo.autonomyCeilingUsd)} ceiling until 00:00 UTC`,
    };
  };
  return candidates.map((c) => ({ ...worded(c), consequence: c.consequence }));
}
/** The id of the form a row's own button submits (see `decisionForm`). */
const askFormId = (d: Decision): string => `ask-${d.id}`;

/**
 * The form behind a row's landing button — its own post, exactly as it was.
 * It sits after the panel's form, because a form inside a form is not
 * HTML; the button reaches it by id.
 */
export function decisionForm(d: Decision): Html | null {
  const pull = d.pull;
  if (pull === undefined) return null;
  const base = repoBase(d.repo);
  const own = html`id="${askFormId(d)}" method="post" hidden`;
  if (d.kind === "stopped")
    return html`<form ${own} action="${base}/pulls/${pull.number}/state">
      <input type="hidden" name="state" value="closed" />
    </form>`;
  if (d.kind === "look")
    return html`<form ${own} action="${base}/pulls/${pull.number}/ship">
      <input type="hidden" name="pull" value="${pull.number}" />
    </form>`;
  return null;
}

/**
 * The actions on one ask, on one line: a button for what lands (submitting
 * the row's own form, `decisionForm`), links for what needs a look or a
 * word. Saying something to the crew happens on the change's own page,
 * where the conversation is — not in a box in a list.
 */
export function decisionActions(ctx: Ctx, d: Decision): Html {
  const base = repoBase(d.repo);
  const pull = d.pull;
  const preview =
    pull === undefined
      ? undefined
      : getAppByRepo(ctx.app.db, d.repo.id) === undefined
        ? undefined
        : `${base}/app/pull-${pull.number}/open`;
  if (d.kind === "stopped" && pull)
    return html`${btn("Tell them", {
      href: `${changeHref(base, pull.number)}#comment-body`,
      size: "sm",
      variant: "primary",
    })}
    ${btn("Close", {
      size: "sm",
      form: askFormId(d),
    })}
    ${btn("See", {
      href: changeHref(base, pull.number),
      size: "sm",
    })}`;
  if (d.kind === "look" && pull)
    return html`${btn("Ship", {
      size: "sm",
      form: askFormId(d),
      variant: "primary",
    })}
    ${when(
      preview,
      (href) =>
        html`${btn("Preview", {
          href,
          size: "sm",
        })}`,
    )}
    ${btn("Not like this", {
      href: `${changeHref(base, pull.number)}#comment-body`,
      size: "sm",
    })}`;
  if (d.kind === "declined" && d.issue)
    return html`${btn("Answer", {
      href: `${base}/issues/${d.issue.number}#comment-body`,
      size: "sm",
      variant: "primary",
    })}`;
  if (d.kind === "parked" && d.issue)
    return html`${btn("Tell them", {
      href: `${base}/issues/${d.issue.number}#comment-body`,
      size: "sm",
      variant: "primary",
    })}`;
  return html`${btn("Settings", {
    href: `${base}/settings/autonomy`,
    size: "sm",
  })}`;
}

/**
 * What the forge itself needs, for a site admin: each sentence of the
 * health answer (`/api/v1/health`) as one ask. Anyone else gets none — the
 * forge's standing is the admin's to read and nobody else's to know about.
 */
export function forgeNeedsFor(ctx: Ctx, user: User | undefined): string[] {
  if (!user?.isAdmin) return [];
  const runtime = appsRuntime(ctx.app);
  const envs = runtime
    ? listApps(ctx.app.db).flatMap((record) => runtime.status(record))
    : [];
  return vitals({
    db: ctx.app.db,
    dataDir: ctx.app.config.dataDir,
    envs,
  }).needs;
}

/**
 * How many things ask the viewer: the one number the studio header and the
 * asks page both show. It counts the rows the cards are made into
 * (`askRows` over `waitingOn`) plus the forge's own needs, so the two
 * cannot disagree.
 */
export function askCountFor(ctx: Ctx, user: User | undefined): number {
  if (!user) return 0;
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  return (
    askRows(waitingOn(ctx.app.db, user, repos)).length +
    forgeNeedsFor(ctx, user).length
  );
}

/** The single sentence the asks page leads with, and the dashboard links with. */
export function askSentence(count: number): string {
  return count === 0
    ? "All fine"
    : `${count} ${count === 1 ? "thing needs" : "things need"} you`;
}

/**
 * What asks the viewer, as data: the rows most consequential first (each
 * with its decision, options and default), the forge's own needs for an
 * admin, and the week's measure of asks raised against acted on, dismissed
 * and gone by themselves. `GET /api/v1/asks` and the MCP's `asks` read this.
 */
export function asksAnswer(ctx: Ctx, user: User) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return {
    rows: askLinesFor(ctx.app.db, user),
    forge: forgeNeedsFor(ctx, user),
    measure: { days: 7, ...askMeasure(ctx.app.db, user.id, since) },
  };
}
