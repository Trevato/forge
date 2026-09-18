/**
 * What asks a person, and what they can do about it: a *decision* is one
 * card — a pull the crew stopped on, a green pull waiting for a look, or a
 * repository parked at its ceiling — read from the same tables the rest of
 * the forge reads, with the same access the owner has. This module owns the
 * card, the row, the panel of them and the bulk bar; every button here posts
 * to the route a person could have posted to by hand (`actions.ts`).
 */

import { previewEnv } from "../../apps/data.ts";
import { crewForRepos } from "../../core/agents.ts";
import { appsForRepos, getAppByRepo } from "../../core/apps.ts";
import { latestDecision } from "../../core/decisions.ts";
import {
  listComments,
  listOpenAgentPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import { looksForApps } from "../../core/looks.ts";
import { joinMany, type Pull } from "../../core/pulls.ts";
import { canSeeOwnerFacts, listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { listReviews } from "../../core/reviews.ts";
import {
  activeRunFor,
  automaticRunsSince,
  latestRunsForIssues,
} from "../../core/runs.ts";
import type { User } from "../../core/users.ts";
import { spentTodayForRepos } from "../../crew/autonomy.ts";
import { CHECK_FAILED_LIMIT } from "../../crew/dispatch.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { btn, card, icon, row } from "../ui.ts";
import { lookThumb, lookUrl } from "../pages/looks.ts";
import { leanNote, leanVariant } from "./leans.ts";

/** The apps a person can see, as repositories, with their records. */
export function appsOf(ctx: Ctx, user: User) {
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  return { repos: repos.filter((r) => records.has(r.id)), records };
}


export type DecisionKind = "stopped" | "look" | "paused";

/** Dollars as a person reads them: cents when small, whole when not. */
const dollars = (n: number): string => (n < 10 ? n.toFixed(2) : n.toFixed(0));

export interface Decision {
  readonly kind: DecisionKind;
  /** Stable across renders — the kind and what it is about — so a form can
   * name it and a later request can find it again. */
  readonly id: string;
  readonly repo: Repo;
  readonly pull?: Pull | undefined;
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
function lastHumanWord(ctx: Ctx, issue: Issue, agentName: string): string {
  let latest = issue.createdAt;
  for (const c of listComments(ctx.app.db, issue.id))
    if (c.authorName !== agentName && c.createdAt > latest)
      latest = c.createdAt;
  for (const r of listReviews(ctx.app.db, issue.id))
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
  readonly who: string;
  /** For "stopped": how many automatic tries, and whether the decider itself stopped it. */
  readonly tries?: number;
  readonly stoppedByDecider?: boolean;
}

/**
 * The crew's open pulls the viewer may land, sorted into what asks them:
 * stopped (red past the crew's own limit since a person last spoke), or
 * green and waiting for a look. Plus a repository paused at its ceiling.
 * Every read here is bounded by the pulls a person can see or the
 * repositories handed in — never by a loop that queries once per app: the
 * ceiling check reads spend and crew for every repository in one query
 * each (`spentTodayForRepos`, `crewForRepos`), not `autonomyStatus` per
 * repository.
 */
function askCandidatesFor(
  ctx: Ctx,
  allRepos: readonly Repo[],
): AskCandidate[] {
  const db = ctx.app.db;
  const out: AskCandidate[] = [];
  const user = ctx.auth.user;
  if (!user) return out;
  // Shipping, closing and the day's ceiling are the owner's own decisions —
  // a reader who cannot write here is never asked to make one, and never
  // sees the dollar figure a "paused" card would otherwise carry.
  const repos = allRepos.filter((r) => canSeeOwnerFacts(db, r, user));
  const byId = new Map(repos.map((r) => [r.id, r]));
  const pulls = listOpenAgentPullsVisibleTo(db, user, 50).filter((p) =>
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
      const since = lastHumanWord(ctx, issue, who);
      const tries = automaticRunsSince(db, issue.id, since);
      const stopped = latestDecision(db, issue.id, "retry")?.answer === "stop";
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
          tries,
          stoppedByDecider: stopped,
        });
    } else if (check?.state === "ok" && repo.autonomy !== "autonomous") {
      // Autonomous repositories look at their own green pulls: the decider,
      // then the crew's reviewer. Everything else waits for a person.
      out.push({ kind: "look", repo, pull, who });
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
  for (const repo of repos) {
    // Only a ceiling pause is an ask — "nobody" and "no crew" are settings
    // problems, not a decision, so neither needs its own grouped read.
    if (repo.autonomy === "off" || repo.autonomyBy === null) continue;
    if ((crew.get(repo.id)?.length ?? 0) === 0) continue;
    if ((spent.get(repo.id) ?? 0) >= repo.autonomyCeilingUsd)
      out.push({ kind: "paused", repo, who: "the crew" });
  }
  return out;
}

/**
 * What asks the viewer, across every app they can land — the count the
 * topbar carries. The same candidates `decisionsFor` builds its cards
 * from, with no picture read and no text built: cheap on every page, not
 * only the home's.
 */
export function askCountFor(ctx: Ctx, allRepos: readonly Repo[]): number {
  return askCandidatesFor(ctx, allRepos).length;
}

export function decisionsFor(ctx: Ctx, allRepos: readonly Repo[]): Decision[] {
  const db = ctx.app.db;
  const candidates = askCandidatesFor(ctx, allRepos);
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
    const look = looks.find(
      (l) =>
        l.appId === record.id &&
        l.env === env &&
        l.kind === "phone" &&
        l.error === null,
    );
    return look && lookUrl(repoBase(repo), env, look.commitOid, "phone");
  };
  return candidates.map((c): Decision => {
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
      return {
        kind: "look",
        id: `look:${c.pull.id}`,
        repo: c.repo,
        pull: c.pull,
        who: c.who,
        says: `${c.who} finished "${c.pull.title}" and the check is green. Look at the preview, then ship it or say what is off.`,
        short: `${c.who} finished it; the check is green`,
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
// ---- deciding several at once ----

/**
 * What a person can decide for several asks in one go: an ask's own landing
 * button, applied to each. Only what needs no words qualifies — saying
 * something happens on the change's page. The page shows an action only
 * while every checked ask takes it; the route skips one that does not.
 */
export type BulkAction = "ship" | "close";

export const BULK: Readonly<
  Record<
    BulkAction,
    {
      readonly kinds: readonly DecisionKind[];
      readonly label: string;
      readonly done: string;
    }
  >
> = {
  ship: { kinds: ["look"], label: "Ship", done: "Shipped" },
  close: { kinds: ["stopped"], label: "Close", done: "Closed" },
};
const BULK_ACTIONS = Object.keys(BULK) as readonly BulkAction[];
export const isBulkAction = (v: string): v is BulkAction =>
  Object.hasOwn(BULK, v);
export const takes = (d: Decision, a: BulkAction): boolean =>
  BULK[a].kinds.includes(d.kind);

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
      href: `${base}/pulls/${pull.number}#comment-body`,
      size: "sm",
      ...leanVariant(d, "say", "primary"),
    })}${leanNote(d, "say")}
    ${btn("Close", {
      size: "sm",
      form: askFormId(d),
      ...leanVariant(d, "close", undefined),
    })}${leanNote(d, "close")}
    ${btn("See", {
      href: `${base}/pulls/${pull.number}`,
      size: "sm",
      ...leanVariant(d, "look", undefined),
    })}${leanNote(d, "look")}`;
  if (d.kind === "look" && pull)
    return html`${btn("Ship", {
      size: "sm",
      form: askFormId(d),
      ...leanVariant(d, "ship", "primary"),
    })}${leanNote(d, "ship")}
    ${when(
      preview,
      (href) =>
        html`${btn("Preview", {
          href,
          size: "sm",
          ...leanVariant(d, "preview", undefined),
        })}${leanNote(d, "preview")}`,
    )}
    ${btn("Not like this", {
      href: `${base}/pulls/${pull.number}#comment-body`,
      size: "sm",
      ...leanVariant(d, "say", undefined),
    })}${leanNote(d, "say")}`;
  return html`${btn("Settings", {
    href: `${base}/settings/autonomy`,
    size: "sm",
  })}`;
}

/** One decision as a row: a box to pick it, what it says, the options in place. */
function decisionRow(ctx: Ctx, d: Decision): Html {
  const base = repoBase(d.repo);
  const glyph =
    d.kind === "stopped" ? "alert" : d.kind === "look" ? "eye" : "clock";
  // The title links; the row itself does not, because it holds controls
  // and a control inside an anchor is not HTML a browser will keep together.
  const href = d.pull ? `${base}/pulls/${d.pull.number}` : base;
  const title = html`<a href="${href}">${d.pull?.title ?? d.repo.name}</a>`;
  return row({
    lead: html`<input
        class="studio-ask-pick"
        type="checkbox"
        name="ask"
        value="${d.id}"
        data-kind="${d.kind}"
        data-repo="${base}"
        aria-label="Select: ${d.pull?.title ?? d.repo.name}"
      />${d.picture === undefined ? icon(glyph) : lookThumb(href, d.picture)}`,
    title,
    titleAttr: d.says,
    meta: html`${d.repo.name}${d.pull ? html` #${d.pull.number}` : null} ·
    ${d.short}`,
    trail: html`<span class="studio-ask-actions"
      >${decisionActions(ctx, d)}</span
    >`,
  });
}

/**
 * The asks as one form. Every row has a box; check any and a bar appears
 * with what fits them all, posting to /studio/asks. A row's own button
 * submits that row's form, placed after this one — nothing is nested, and
 * one decision is exactly the post it was before.
 */
export function asksPanel(
  ctx: Ctx,
  decisions: readonly Decision[],
  back: string,
): Html {
  const bar = html`<div class="studio-bulk">
    <output class="studio-bulk-count">Selected</output>
    ${BULK_ACTIONS.map((a) =>
      btn(BULK[a].label, { size: "sm", name: "action", value: a }),
    )}
    <span class="muted studio-bulk-none">no one action fits them all</span>
  </div>`;
  return html`<div class="studio-asks">
    <form method="post" action="/studio/asks">
      <input type="hidden" name="back" value="${back}" />
      ${card(
        html`${bar}
          <ul class="list">
            ${decisions.map((d) => decisionRow(ctx, d))}
          </ul>`,
        {
          head: html`${icon("alert")}
            <h2>Asks you</h2>
            <span class="muted small">decide, and the crew carries on</span>`,
          pad: false,
        },
      )}
    </form>
    ${decisions.map(decisionForm)}
  </div>`;
}

/**
 * An action in the bar shows only while every checked ask takes it, and a
 * note when none does — from the same table the route enforces, so the
 * page cannot offer what the server would skip. CSS alone: it holds with
 * scripts off.
 */
export const bulkCss = ((): string => {
  const other = (a: BulkAction): string =>
    `[name="ask"]${BULK[a].kinds.map((k) => `:not([data-kind="${k}"])`).join("")}:checked`;
  return [
    ...BULK_ACTIONS.map(
      (a) =>
        `.studio-asks:has(${other(a)}) [name="action"][value="${a}"] { display: none; }`,
    ),
    `.studio-asks${BULK_ACTIONS.map((a) => `:has(${other(a)})`).join("")} .studio-bulk-none { display: inline; }`,
  ].join("\n");
})();
