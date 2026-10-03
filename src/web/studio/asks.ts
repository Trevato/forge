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
import {
  getIssueById,
  listComments,
  listOpenPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import { looksForApps } from "../../core/looks.ts";
import { joinMany, type Pull } from "../../core/pulls.ts";
import {
  canSeeOwnerFacts,
  listReposVisibleTo,
  listReposWritableTo,
  type Repo,
} from "../../core/repos.ts";
import { listReviews } from "../../core/reviews.ts";
import {
  activeRunFor,
  automaticRunsSince,
  latestRunsForIssues,
} from "../../core/runs.ts";
import type { User } from "../../core/users.ts";
import { isPausedAtCeiling, spentTodayForRepos } from "../../crew/autonomy.ts";
import { breakerParked } from "../../crew/breaker.ts";
import { CHECK_FAILED_LIMIT } from "../../crew/dispatch.ts";
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

export type DecisionKind = "stopped" | "look" | "paused" | "parked";

/** Dollars as a person reads them: cents when small, whole when not. */
const dollars = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(0));

export interface Decision {
  readonly kind: DecisionKind;
  /** Stable across renders — the kind and what it is about — so a form can
   * name it and a later request can find it again. */
  readonly id: string;
  readonly repo: Repo;
  readonly pull?: Pull | undefined;
  /** For "parked": the issue the breaker stopped. */
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
}

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
  const repos = allRepos.filter((r) => canSeeOwnerFacts(db, r, user));
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
          repo,
          pull,
          who,
          authorIsAgent: true,
          tries,
          stoppedByDecider: stopped,
        });
    } else if (check?.state === "ok" && repo.autonomy !== "autonomous") {
      // Autonomous repositories look at their own green pulls: the decider,
      // then the crew's reviewer. Everything else waits for a person —
      // whoever opened it, since a green change asks to be looked at
      // whether the crew wrote it or a person did.
      out.push({
        kind: "look",
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
  for (const repo of repos)
    if (isPausedAtCeiling(repo, crew, spent))
      out.push({ kind: "paused", repo, who: "the crew" });
  // An issue the breaker parked waits for a person's word.
  for (const p of breakerParked(
    db,
    repos.map((r) => r.id),
  )) {
    const issue = getIssueById(db, p.issueId);
    const repo = byId.get(p.repoId);
    if (issue && repo) out.push({ kind: "parked", repo, issue, who: "the crew" });
  }
  return out;
}

/**
 * What asks `user` right now, as a stable id and one plain line each — the
 * panel's own candidates (same visibility, same bounds), without the
 * pictures. What the phone's notifier compares from one moment to the next.
 */
export function askLinesFor(
  db: Database,
  user: User,
): {
  id: string;
  line: string;
  kind: DecisionKind;
  repoId: string;
  /** The pull's number, for the asks that are about one. */
  number?: number;
}[] {
  const repos = listReposVisibleTo(db, user, { limit: 200 });
  return askCandidatesFor(db, user, repos).map((c) => {
    const repo = `${c.repo.name}`;
    const about = { kind: c.kind, repoId: c.repo.id };
    if (c.kind === "paused")
      return {
        ...about,
        id: `paused:${c.repo.id}`,
        line: `${repo} is paused at its ceiling`,
      };
    if (c.kind === "parked")
      return {
        ...about,
        number: c.issue!.number,
        id: `parked:${c.issue!.id}`,
        line: `${repo}: the crew parked #${c.issue!.number} after three failed runs`,
      };
    const title = c.pull?.title ?? "";
    const number = c.pull!.number;
    return c.kind === "stopped"
      ? {
          ...about,
          number,
          id: `stopped:${c.pull!.id}`,
          line: `${repo}: the crew stopped on "${title}"`,
        }
      : {
          ...about,
          number,
          id: `look:${c.pull!.id}`,
          line: `${repo}: "${title}" is green, waiting for your look`,
        };
  });
}

export function decisionsFor(ctx: Ctx, allRepos: readonly Repo[]): Decision[] {
  const db = ctx.app.db;
  const candidates = askCandidatesFor(db, ctx.auth.user, allRepos);
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
  return candidates.map((c): Decision => {
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
  });
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
 * asks page both show. It counts the same candidates the cards are made
 * from (`askCandidatesFor`) plus the forge's own needs, so the two cannot
 * disagree.
 */
export function askCountFor(ctx: Ctx, user: User | undefined): number {
  if (!user) return 0;
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  return (
    askCandidatesFor(ctx.app.db, user, repos).length +
    forgeNeedsFor(ctx, user).length
  );
}

/** The single sentence the asks page leads with, and the dashboard links with. */
export function askSentence(count: number): string {
  return count === 0
    ? "All fine"
    : `${count} ${count === 1 ? "thing needs" : "things need"} you`;
}
