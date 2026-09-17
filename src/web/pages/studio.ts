/**
 * The studio: the forge with apps as the unit. A person does three things
 * to an app here — tell the crew, look at what it made, decide when it
 * asks — and every word on the page maps to one thing in git that dev mode
 * shows. Nothing here is a second system: these pages read the same tables
 * as the rest and act through the same actions a person would take by
 * hand.
 *
 * Words: *tell* is an issue; *working* is a run; *look* is an open pull
 * with a green check and a preview; *shipped* is a merge; *asks you* is a
 * pull the crew stopped on, or a green one waiting for a look.
 */

import {
  addComment,
  assignIssue,
  openIssue,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { mergePull } from "../../actions/pulls.ts";
import { tellCrew } from "../../actions/crew.ts";
import { envPull, previewEnv } from "../../apps/data.ts";
import {
  appsRuntime,
  type AppsRuntime,
  type EnvState,
  type EnvStatus,
} from "../../apps/runtime.ts";
import { listCrewRoles, type Agent } from "../../core/agents.ts";
import { appsForRepos, getAppByRepo, type AppRecord } from "../../core/apps.ts";
import {
  getIssueById,
  listComments,
  listIssues,
  listOpenAgentPullsVisibleTo,
  type Issue,
} from "../../core/issues.ts";
import {
  getPull,
  joinMany,
  listPulls,
  openPullsClosing,
  type Pull,
} from "../../core/pulls.ts";
import { canWrite, listReposVisibleTo, type Repo } from "../../core/repos.ts";
import { listReviews } from "../../core/reviews.ts";
import {
  activeRunFor,
  automaticRunsSince,
  latestAgentRunsForRepos,
  latestRunsForIssues,
  listActiveRuns,
  listRuns,
  type Run,
} from "../../core/runs.ts";
import { getUserById, getUsersByIds, type User } from "../../core/users.ts";
import { autonomyStatus, bringUpToDate } from "../../crew/autonomy.ts";
import {
  decisionStats,
  latestDecision,
  latestLean,
  recordDecision,
  type DecisionStat,
} from "../../core/decisions.ts";
import { routeIssue } from "../../crew/route.ts";
import { certain, decideOr, type Decider } from "../../crew/decide.ts";
import { CHECK_FAILED_LIMIT } from "../../crew/dispatch.ts";
import type { Ctx } from "../../http/context.ts";
import { createLog } from "../../kernel/log.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { asksJs } from "../client.ts";
import { flashOrJson, flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { isMode, modeCookie } from "../mode.ts";
import {
  avatar,
  badge,
  btn,
  card,
  dot,
  empty,
  envActions,
  envFacts,
  envPhrase,
  icon,
  listCard,
  pill,
  row,
  time,
  userTag,
  type Tone,
} from "../ui.ts";
import { looksForApps } from "../../core/looks.ts";
import { lookNow, lookThumb, lookUrl } from "./looks.ts";
import { onYouCard } from "./site.ts";

// ---- decisions: what asks a person ----

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

/** The options a card offers, by name, as the decider sees them. */
const CARD_OPTIONS: Record<DecisionKind, Readonly<Record<string, string>>> = {
  stopped: {
    say: "Tell the builder what to try; the check can pass with guidance.",
    close: "Close it; the change is not worth more tries.",
    look: "A person should read the change before deciding.",
  },
  look: {
    ship: "Ship it; the change is green and small enough to land on its check.",
    say: "Say what is off; something in it needs a change first.",
    preview: "Open the preview first; it must be seen before shipping.",
  },
  paused: { settings: "Raise the ceiling.", wait: "Wait for midnight." },
};

const log = createLog("studio");

/** A pull's head oid, or "" for a card with no commit to key a lean on. */
const headOf = (d: Decision): string => d.pull?.headOid ?? "";

/** One background ask per card+head, so a page rendered by many people at
 * once never fans out past one call per card. Cleared once answered. */
const leanInFlight = new Map<string, Promise<void>>();

/** A pause before asking, long enough that the response for the render
 * which triggered the ask is on its way out first — the point is that the
 * decider is never on the request's critical path, not that the ask is
 * instant. */
const LEAN_ASK_DELAY_MS = 50;

/**
 * Ask the decider which option on a card is likely right, off the request
 * path — after this turn of the event loop, never inside it — and remember
 * the answer keyed to the head it was about. A rule's answer is not worth
 * remembering: it is what the page would have shown anyway.
 */
function scheduleLean(ctx: Ctx, d: Decision, decider: Decider): void {
  const head = headOf(d);
  const key = `${d.id}@${head}`;
  if (leanInFlight.has(key)) return;
  const options = Object.keys(CARD_OPTIONS[d.kind]);
  const state = {
    card: d.kind,
    head,
    repository: `${d.repo.ownerName}/${d.repo.name}`,
    situation: d.says,
    ...(d.pull === undefined
      ? {}
      : { change: d.pull.title, description: d.pull.body.slice(0, 800) }),
  };
  const asked = new Promise<void>((resolve) => {
    setTimeout(() => {
      decideOr(
        decider,
        state,
        {
          option: {
            options,
            about: "Which of these a careful owner of the app would pick.",
            describe: CARD_OPTIONS[d.kind],
          },
        },
        () => ({ option: certain(options, options[0]!) }),
      )
        .then((decided) => {
          if (decided.by === "rule") return;
          recordDecision(ctx.app.db, {
            kind: "lean",
            repoId: d.repo.id,
            issueId: d.pull?.id,
            state,
            answer: decided.answers.option.choice,
            p: decided.answers.option.p,
            by: decided.by,
            ms: decided.ms,
          });
        })
        .catch((error) =>
          log.warn("lean not recorded", { id: d.id, error: String(error) }),
        )
        .finally(() => {
          leanInFlight.delete(key);
          resolve();
        });
    }, LEAN_ASK_DELAY_MS);
  });
  leanInFlight.set(key, asked);
}

/** Test hook: every ask scheduled so far, answered or not. The page itself
 * never waits on this — only a test that wants the next render to have it. */
export function pendingLeans(): Promise<unknown> {
  return Promise.allSettled([...leanInFlight.values()]);
}

/**
 * Every card with the lean already known about it, read with no wait; a
 * card whose lean is unknown, or whose head has moved past the one it was
 * asked about, is asked for off the request path (`scheduleLean`) so a
 * later render has it. A forge with no decider does nothing here, exactly
 * as before.
 */
export function withLikely(
  ctx: Ctx,
  decisions: readonly Decision[],
): Decision[] {
  const decider = ctx.app.config.decider;
  if (decider === undefined) return [...decisions];
  return decisions.map((d) => {
    const lean = latestLean(
      ctx.app.db,
      d.repo.id,
      d.pull?.id ?? null,
      d.kind,
      headOf(d),
    );
    if (lean === undefined) {
      scheduleLean(ctx, d, decider);
      return d;
    }
    return { ...d, likely: { option: lean.answer, p: lean.p } };
  });
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
 * The crew's open pulls the viewer may land, sorted into what asks them:
 * stopped (red past the crew's own limit since a person last spoke), or
 * green and waiting for a look. Plus a repository paused at its ceiling.
 */
export function decisionsFor(ctx: Ctx, repos: readonly Repo[]): Decision[] {
  const db = ctx.app.db;
  const out: Decision[] = [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const user = ctx.auth.user;
  if (!user) return out;
  const pulls = listOpenAgentPullsVisibleTo(db, user, 50).filter((p) =>
    byId.has(p.repoId),
  );
  const checks = latestRunsForIssues(
    db,
    pulls.map((p) => p.id),
  );
  const joined = new Map(joinMany(db, pulls).map((p) => [p.id, p]));
  // The pictures, in one read: a green pull's row leads with its preview.
  const records = appsForRepos(db, [...byId.keys()]);
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
          id: `stopped:${pull.id}`,
          repo,
          pull,
          who,
          says: stopped
            ? `${who}'s check failed and the crew's decider stopped rather than spend another run. Say what to try, or close it.`
            : `${who} tried ${tries + 1} times and the check still fails. The crew stopped here. Say what to try, or close it.`,
          short: stopped
            ? `the check failed; the decider stopped for you`
            : `${who} tried ${tries + 1} times; the check still fails`,
        });
    } else if (check?.state === "ok" && repo.autonomy !== "autonomous") {
      // Autonomous repositories look at their own green pulls: the decider,
      // then the crew's reviewer. Everything else waits for a person.
      const picture = pictureOf(repo, pull);
      out.push({
        kind: "look",
        id: `look:${pull.id}`,
        repo,
        pull,
        who,
        says: `${who} finished "${pull.title}" and the check is green. Look at the preview, then ship it or say what is off.`,
        short: `${who} finished it; the check is green`,
        ...(picture === undefined ? {} : { picture }),
      });
    }
  }
  for (const repo of repos) {
    if (repo.autonomy === "off") continue;
    const s = autonomyStatus(ctx.app, repo);
    if (s.paused === "ceiling")
      out.push({
        kind: "paused",
        id: `paused:${repo.id}`,
        repo,
        who: "the crew",
        says: `${repo.name} reached its $${dollars(s.ceilingUsd)} for today. The crew picks nothing more until 00:00 UTC. Raise the ceiling in settings to go on now.`,
        short: `at its $${dollars(s.ceilingUsd)} ceiling until 00:00 UTC`,
      });
  }
  return out;
}

/** The variant a card's button takes: primary when the decider leans to it. */
function leanVariant(
  d: Decision,
  option: string,
  fallback: "primary" | undefined,
): { variant?: "primary" } {
  const variant =
    d.likely === undefined
      ? fallback
      : d.likely.option === option
        ? "primary"
        : undefined;
  return variant === undefined ? {} : { variant };
}

/** A word beside the leaned-to option: how sure, in plain terms. */
function leanNote(d: Decision, option: string): Html | null {
  if (d.likely === undefined || d.likely.option !== option) return null;
  const sure =
    d.likely.p >= 0.85 ? "likely" : d.likely.p >= 0.6 ? "probably" : "maybe";
  return html`<span
    class="muted small studio-lean"
    title="${Math.round(d.likely.p * 100)}% by the decider"
    >${sure}</span
  >`;
}

// ---- deciding several at once ----

/**
 * What a person can decide for several asks in one go: an ask's own landing
 * button, applied to each. Only what needs no words qualifies — saying
 * something happens on the change's page. The page shows an action only
 * while every checked ask takes it; the route skips one that does not.
 */
export type BulkAction = "ship" | "close";

const BULK: Readonly<
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
const isBulkAction = (v: string): v is BulkAction => Object.hasOwn(BULK, v);
const takes = (d: Decision, a: BulkAction): boolean =>
  BULK[a].kinds.includes(d.kind);

/** The id of the form a row's own button submits (see `decisionForm`). */
const askFormId = (d: Decision): string => `ask-${d.id}`;

/**
 * The form behind a row's landing button — its own post, exactly as it was.
 * It sits after the panel's form, because a form inside a form is not
 * HTML; the button reaches it by id.
 */
function decisionForm(d: Decision): Html | null {
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
function decisionActions(ctx: Ctx, d: Decision): Html {
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

// ---- studio words for what the crew is doing ----

/** A merge refusal in a person's words. */
function mergeWords(error: unknown): string {
  if (typeof error === "string") return error.replace(/_/g, " ");
  if (typeof error === "object" && error !== null && "kind" in error) {
    const e = error as { kind: string; message?: string };
    if (e.kind === "git") return `git said ${e.message ?? "no"}`;
    return e.kind.replace(/_/g, " ");
  }
  return String(error);
}

/**
 * The week's decisions in one line: how many, how many the decider took
 * rather than the rule, and what came of the ones that are known.
 * "12 · 11 by typesafe · shipped 5, shown 2, stopped 1"
 */
function decisionWords(stats: readonly DecisionStat[]): Html {
  const n = stats.reduce((s, k) => s + k.n, 0);
  const decided = stats.reduce((s, k) => s + k.decided, 0);
  const by = stats
    .flatMap((k) => Object.entries(k.outcomes))
    .reduce<Record<string, number>>((acc, [o, c]) => {
      acc[o] = (acc[o] ?? 0) + c;
      return acc;
    }, {});
  const outcomes = Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([o, c]) => `${o} ${c}`)
    .join(", ");
  return html`${n}
    <span class="muted"
      >· ${decided} by the
      decider${outcomes === "" ? "" : ` · ${outcomes}`}</span
    >`;
}

/**
 * The one control a live run has: a person who can write here stops a
 * running one or takes a queued one back off the board. Nothing for runs
 * that are over, or for readers.
 */
function stopForm(ctx: Ctx, repo: Repo, run: Run): Html | null {
  if (run.state !== "running" && run.state !== "queued") return null;
  if (run.kind !== "agent") return null;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return null;
  return html`<form
    method="post"
    action="${repoBase(repo)}/runs/${run.id}/cancel"
  >
    ${btn(run.state === "running" ? "Stop" : "Cancel", {
      size: "sm",
      variant: "outline",
    })}
  </form>`;
}

type Word = "working" | "look" | "shipped" | "stopped" | "waiting" | "planned";

function wordFor(run: Run): { word: Word; note: string } {
  if (run.state === "queued")
    return run.notBefore === null
      ? { word: "waiting", note: "queued" }
      : { word: "waiting", note: "paused, resumes soon" };
  if (run.state === "running") return { word: "working", note: "now" };
  if (run.state === "failed" || run.state === "cancelled")
    return { word: "stopped", note: run.summary || run.state };
  const summary = run.summary || "";
  if (/opened pull|updated pull/.test(summary))
    return { word: "look", note: summary };
  if (/planned|no changes pushed/.test(summary))
    return { word: "planned", note: summary };
  return { word: "shipped", note: summary };
}

const WORD_ICON: Record<Word, Parameters<typeof icon>[0]> = {
  working: "loader",
  look: "eye",
  shipped: "check",
  stopped: "alert",
  waiting: "clock",
  planned: "map",
};

// ---- previews: every open pull's preview, one click away ----

/** The three words the studio uses for a preview, whatever its check says. */
function previewBadge(state: EnvState | undefined): Html {
  if (state === "running")
    return badge("live", { tone: "success", icon: "play" });
  if (state === "deploying")
    return badge("starting", { tone: "attn", icon: "loader" });
  return badge("not up", {
    ...(state === "failed" ? { tone: "danger" as const } : {}),
    icon: "square",
  });
}

/**
 * One open pull's preview, as one row: its host is the click, its state is
 * the badge, and a check still running or a check that failed says so right
 * there — the row never hides a preview that is serving.
 */
function previewRow(
  base: string,
  runtime: AppsRuntime | undefined,
  record: AppRecord,
  pull: Pull,
  env: EnvStatus | undefined,
): Html {
  const href =
    runtime === undefined
      ? undefined
      : `${base}/app/${previewEnv(pull.number)}/open`;
  const host =
    runtime === undefined
      ? undefined
      : runtime.urlFor(record, previewEnv(pull.number)).replace(/^https?:\/\//, "");
  const bits: Html[] = [html`#${pull.number} ${pull.title}`];
  if (env?.commitOid) bits.push(html`${env.commitOid.slice(0, 7)}`);
  if (env?.since) bits.push(html`up ${time(env.since)}`);
  const say = env?.error ?? env?.note;
  if (say) bits.push(html`${say}`);
  return row({
    ...(href === undefined ? {} : { href, nav: true }),
    lead: icon("rocket"),
    title:
      host === undefined
        ? `#${pull.number} ${pull.title}`
        : html`<span class="mono">${host}</span>`,
    meta: bits.reduce((a, b) => html`${a} · ${b}`),
    trail: previewBadge(env?.state),
  });
}

/**
 * Every open pull's preview, one row each, from the runtime's own `status()`
 * — no per-pull query, so the list costs nothing extra as pulls pile up. A
 * pull with no environment yet still gets a row, so the list matches the
 * open pulls exactly.
 */
function previewsPanel(
  base: string,
  runtime: AppsRuntime | undefined,
  record: AppRecord,
  openPulls: readonly Pull[],
  envs: readonly EnvStatus[],
): Html | null {
  if (openPulls.length === 0) return null;
  const byPull = new Map(
    envs
      .filter((e) => e.env !== "production")
      .map((e) => [envPull(e.env), e] as const),
  );
  return listCard(
    openPulls.map((p) =>
      previewRow(base, runtime, record, p, byPull.get(p.number)),
    ),
    {
      head: html`${icon("rocket")}
        <h2>Previews</h2>`,
    },
  );
}

// ---- the app in the studio ----

export async function studioApp(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const crew = listCrewRoles(db, repo.id);
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const runs = listRuns(db, repo.id, { kind: "agent", limit: 8 });
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const issues = new Map<string, Issue>();
  for (const r of runs)
    if (r.issueId !== null && !issues.has(r.issueId)) {
      const i = getIssueById(db, r.issueId);
      if (i) issues.set(r.issueId, i);
    }
  const decisions = withLikely(ctx, decisionsFor(ctx, [repo]));
  const openPulls = listPulls(db, repo.id, { state: "open", limit: 10 });
  const pullChecks = latestRunsForIssues(
    db,
    openPulls.map((p) => p.id),
  );
  const week = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const weekRuns = listRuns(db, repo.id, { kind: "agent", limit: 200 }).filter(
    (r) => r.createdAt >= week,
  );
  const spent = weekRuns.reduce((s, r) => s + r.costUsd, 0);
  const shipped = listPulls(db, repo.id, {
    state: "closed",
    limit: 100,
  }).filter((p) => p.mergedAt !== null && p.mergedAt >= week).length;
  const ledgerWeek = decisionStats(db, repo.id, week);
  const autonomy =
    repo.autonomy === "off" ? undefined : autonomyStatus(ctx.app, repo);
  const moving = runs.some(
    (r) => r.state === "running" || r.state === "queued",
  );

  // ---- the app itself ----
  const runtime = appsRuntime(ctx.app);
  const envs: EnvStatus[] = runtime === undefined ? [] : runtime.status(record);
  const previews = previewsPanel(base, runtime, record, openPulls, envs);
  const production = envs.find((e) => e.env === "production");
  const url = runtime?.urlFor(record, "production");
  const writer = canWrite(db, repo, ctx.auth.user);
  // The state in one word, and under it the same facts the App page shows —
  // why it is not up, and the deploy whose log says the rest.
  const live = envPhrase(production);
  const head = html`<div class="page-head studio-head">
    <div class="stack" style="gap: 4px">
      <h1>
        ${repo.name}
        ${badge(
          live.word,
          live.tone === "default"
            ? { variant: "secondary" }
            : { tone: live.tone },
        )}
      </h1>
      <p class="muted">
        ${repo.description || "No description yet."}
        ${url === undefined
          ? null
          : html`·
              <a href="${base}/app/production/open" class="mono"
                >${url.replace(/^https?:\/\//, "")}</a
              >`}
      </p>
      ${when(production, (env) => envFacts(base, env))}
    </div>
    <span class="spacer"></span>
    ${lookNow(ctx, repo, record)}
    ${btn("Open the app", {
      href: `${base}/app/production/open`,
      variant: "primary",
      icon: "external",
    })}
    ${when(production, (env) => envActions(base, env, writer))}
  </div>`;

  // ---- the box ----
  const tell = html`<form
    class="card comment-form studio-tell"
    method="post"
    action="${base}/tell"
  >
    <label class="sr-only" for="tell">Tell the crew</label>
    <textarea
      class="input"
      id="tell"
      name="text"
      rows="3"
      required
      placeholder="${builders.length === 0
        ? "Add a crew member under Settings → Crew, then tell them what you want."
        : "What should change? One thing at a time works best."}"
    ></textarea>
    <div class="bar">
      <span class="muted small">
        ${builders.length === 0
          ? html`Nobody on the crew yet.`
          : html`${builders
              .map((b) => userTag(b.user.username))
              .reduce((a, b) => html`${a} ${b}`)}
            ${builders.length === 1 ? "takes it" : "share the work"}`}
      </span>
      <span class="spacer"></span>
      ${btn("Tell the crew", { variant: "primary", type: "submit" })}
    </div>
  </form>`;

  // ---- now: one row per thing, in the five words ----
  const proposed = new Set(openPulls.map((p) => p.id));
  const openByIssue = openPullsClosing(db, repo.id);
  const told = listIssues(db, repo.id, {
    kind: "issue",
    state: "open",
    limit: 30,
  }).filter((i) => i.assigneeIsAgent && !openByIssue.has(i.number));
  const everRan = latestRunsForIssues(
    db,
    told.map((i) => i.id),
    ["agent"],
  );
  const waiting = told.filter((i) => !everRan.has(i.id)).slice(0, 5);
  const issueNumberById = new Map(told.map((i) => [i.id, i.number]));
  const rowsNow = runs
    .filter((r) => {
      if (r.issueId === null) return true;
      if (proposed.has(r.issueId)) return false;
      const n = issueNumberById.get(r.issueId) ?? issues.get(r.issueId)?.number;
      return n === undefined || !openByIssue.has(n);
    })
    .filter(
      (r, idx, all) => all.findIndex((x) => x.issueId === r.issueId) === idx,
    )
    .slice(0, 6);
  const wordBadge = (word: Word): Html => {
    const variant =
      word === "look" || word === "shipped"
        ? "success"
        : word === "stopped"
          ? "danger"
          : word === "working"
            ? "accent"
            : "secondary";
    return html`<span
      class="badge"
      data-variant="${variant}"
      data-word="${word}"
      >${word === "working" ? icon("loader") : null}${word}</span
    >`;
  };
  const nowRows: Html[] = [
    ...openPulls.map((p) => {
      const check = pullChecks.get(p.id);
      const word: Word =
        check?.state === "ok"
          ? "look"
          : check?.state === "failed"
            ? "stopped"
            : "working";
      return row({
        href: `${base}/pulls/${p.number}`,
        nav: true,
        lead: avatarOf(p.authorName),
        title: p.title,
        meta: html`${p.authorName} ·
        ${word === "look"
          ? "green, ready for a look"
          : word === "stopped"
            ? "the check failed"
            : "checking"}
        · ${time(p.createdAt)}`,
        trail: wordBadge(word),
      });
    }),
    ...rowsNow.map((r) => {
      const { word, note } = wordFor(r);
      const who =
        r.actorId === null
          ? "crew"
          : (actors.get(r.actorId)?.username ?? "crew");
      const about = r.issueId === null ? undefined : issues.get(r.issueId);
      const stop = stopForm(ctx, repo, r);
      return row({
        ...(stop ? {} : { href: `${base}/runs/${r.id}`, nav: true }),
        lead: avatarOf(who),
        title: stop
          ? html`<a href="${base}/runs/${r.id}">${about?.title ?? note}</a>`
          : (about?.title ?? note),
        meta: html`${who} · ${word === "working" ? "working now" : note}
        ${word === "working"
          ? null
          : html` · ${time(r.finishedAt ?? r.createdAt)}`}`,
        trail: stop
          ? html`<span class="studio-ask-actions"
              >${wordBadge(word)} ${stop}</span
            >`
          : wordBadge(word),
      });
    }),
    ...waiting.map((i) =>
      row({
        href: `${base}/issues/${i.number}`,
        nav: true,
        lead: avatarOf(i.assigneeName ?? "crew"),
        title: i.title,
        meta: html`${i.assigneeName} · told ${time(i.createdAt)}, not picked up
        yet`,
        trail: wordBadge("waiting"),
      }),
    ),
  ];
  const now =
    nowRows.length === 0
      ? card(
          html`<p class="muted small">
            Nothing yet. Tell the crew something.
          </p>`,
          {
            head: html`${icon("activity")}
              <h2>Now</h2>`,
          },
        )
      : listCard(nowRows, {
          head: html`${icon("activity")}
            <h2>Now</h2>
            <span class="spacer"></span>
            ${btn("Every run", { href: `${base}/runs`, size: "sm" })}`,
        });

  const asks = when(decisions.length > 0, () =>
    asksPanel(ctx, decisions, base),
  );

  // ---- the rail ----
  const crewCard =
    crew.length === 0
      ? card(
          html`<p class="muted small">
            Nobody yet. <a href="${base}/settings/crew">Add someone.</a>
          </p>`,
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>`,
          },
        )
      : listCard(
          crew.map((c) =>
            row({
              lead: avatarOf(c.agent.user.username),
              title: c.agent.user.username,
              meta: html`${c.role === "builder"
                ? "builds"
                : c.role === "planner"
                  ? "plans"
                  : "reviews"}`,
            }),
          ),
          {
            head: html`${icon("bot")}
              <h2>Crew</h2>
              <span class="spacer"></span>
              ${btn("Change", { href: `${base}/settings/crew`, size: "sm" })}`,
          },
        );
  const weekCard = card(
    html`<dl>
      <dt>Shipped</dt>
      <dd>${shipped} change${shipped === 1 ? "" : "s"}</dd>
      <dt>Runs</dt>
      <dd>${weekRuns.length}</dd>
      <dt>Spent</dt>
      <dd>
        $${spent.toFixed(2)}${shipped > 0
          ? html` <span class="muted"
              >· $${(spent / shipped).toFixed(2)} per shipped change</span
            >`
          : null}
      </dd>
      ${when(
        ledgerWeek.length > 0,
        () =>
          html`<dt>Decided</dt>
            <dd>${decisionWords(ledgerWeek)}</dd>`,
      )}
    </dl>`,
    {
      head: html`${icon("activity")}
        <h2>This week</h2>`,
      extra: "about",
    },
  );
  const ownCard = card(
    autonomy === undefined
      ? html`<p class="muted small">
          Off. <a href="${base}/settings/autonomy">Turn it on</a> and the crew
          works what is ready without being asked.
        </p>`
      : html`<dl>
          <dt>Mode</dt>
          <dd>${repo.autonomy === "autonomous" ? "Autonomous" : "Assisted"}</dd>
          <dt>Today</dt>
          <dd>
            $${autonomy.spentTodayUsd.toFixed(2)} of
            $${autonomy.ceilingUsd.toFixed(0)}
          </dd>
          <dt>Slots</dt>
          <dd>${autonomy.active} of ${autonomy.slots} in use</dd>
          ${autonomy.paused
            ? html`<dt>Paused</dt>
                <dd>
                  ${autonomy.paused === "ceiling"
                    ? "at the ceiling, until 00:00 UTC"
                    : autonomy.paused}
                </dd>`
            : null}
        </dl>`,
    {
      head: html`${icon("play")}
        <h2>On its own</h2>
        <span class="spacer"></span>
        ${btn("Change", { href: `${base}/settings/autonomy`, size: "sm" })}`,
      extra: "about",
    },
  );
  const more = html`<p class="muted small">
    <a href="${base}/map">The map</a> ·
    <a href="${base}/issues">Everything told</a> ·
    <a href="${base}/pulls">Every change</a>
  </p>`;

  const body = html`${repoHeader(ctx, repo, "code", {
      compact: true,
      ownTitle: true,
    })}
    ${head}
    <div class="dash">
      <div class="dash-main stack">${tell} ${asks} ${previews} ${now}</div>
      <aside class="dash-rail stack">
        ${crewCard} ${weekCard} ${ownCard} ${more}
      </aside>
    </div>
    ${when(moving, () => liveMount({ repo: base }))}`;
  return page({
    ctx,
    title: `${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
    scriptJs: `${liveClientJs}\n${asksJs}`,
  });
}

function avatarOf(username: string): Html {
  return avatar(username);
}

// ---- the studio home ----

/**
 * The home in the studio: what asks you first, then every app as one row
 * that carries a real signal — live or not, what the crew last did there,
 * how many things wait on you — and beside it what is happening right now
 * across all of them, and what a person put on you. Built from the same
 * rows and cards as the rest of the forge, so it reads as the forge.
 */
export async function studioHome(ctx: Ctx, user: User): Promise<Response> {
  const db = ctx.app.db;
  const { repos: appRepos, records } = appsOf(ctx, user);
  const runtime = appsRuntime(ctx.app);
  // One read for the newest run of every app, one for who ran them: the
  // home must not get slower as the apps grow.
  const latestRuns = latestAgentRunsForRepos(
    db,
    appRepos.map((r) => r.id),
  );
  const actors = getUsersByIds(
    db,
    [...latestRuns.values()]
      .map((r) => r.actorId)
      .filter((id): id is string => id !== null),
  );
  const decisions = withLikely(ctx, decisionsFor(ctx, appRepos));
  const asksByRepo = new Map<string, number>();
  for (const d of decisions)
    asksByRepo.set(d.repo.id, (asksByRepo.get(d.repo.id) ?? 0) + 1);

  const appRows = appRepos.map((repo) => {
    const record = records.get(repo.id)!;
    const envs = runtime === undefined ? [] : runtime.status(record);
    const production = envs.find((e) => e.env === "production");
    const state = production?.state ?? "stopped";
    const latest = latestRuns.get(repo.id);
    const word = latest === undefined ? undefined : wordFor(latest);
    const who =
      latest?.actorId == null
        ? undefined
        : actors.get(latest.actorId)?.username;
    const asks = asksByRepo.get(repo.id) ?? 0;
    const tone: Tone =
      state === "running"
        ? "success"
        : state === "failed"
          ? "danger"
          : "default";
    const happening =
      latest === undefined || word === undefined
        ? html`<span class="muted">quiet — tell the crew something</span>`
        : html`<span class="studio-word" data-word="${word.word}"
              >${word.word}</span
            >
            ${who ? html`· ${who}` : null}
            ${word.word === "working"
              ? html`· now`
              : html`· ${time(latest.finishedAt ?? latest.createdAt)}`}`;
    return row({
      href: repoBase(repo),
      nav: true,
      lead: dot(tone),
      title: repo.name,
      titleAttr: repo.description || repo.name,
      meta: html`${repo.description
        ? html`${repo.description} · `
        : null}${happening}`,
      trail: html`${asks > 0 ? pill(`${asks} asks you`, "accent") : null}
        <span class="badge" data-tone="${tone}"
          >${state === "running"
            ? "live"
            : state === "stopped"
              ? "not running"
              : state}</span
        >`,
    });
  });

  const apps =
    appRows.length === 0
      ? empty({
          icon: "rocket",
          title: "No apps yet",
          note: "Make one, tell the crew what it is, and watch it come up.",
          action: btn("New app", { href: "/apps/new", variant: "primary" }),
        })
      : listCard(appRows, {
          head: html`${icon("rocket")}
            <h2>Your apps</h2>
            <span class="spacer"></span>
            ${btn("New app", { href: "/apps/new", size: "sm", icon: "plus" })}`,
        });

  const asks = when(decisions.length > 0, () => asksPanel(ctx, decisions, "/"));

  // Happening now: every run in flight across the apps, one read.
  const running = listActiveRuns(
    db,
    appRepos.map((r) => r.id),
  );
  const runActors = getUsersByIds(
    db,
    running.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const byId = new Map(appRepos.map((r) => [r.id, r]));
  const now =
    running.length === 0
      ? card(html`<p class="muted small">Nobody is working right now.</p>`, {
          head: html`${icon("activity")}
            <h2>Happening now</h2>`,
        })
      : listCard(
          running.map((r) => {
            const repo = byId.get(r.repoId)!;
            const who =
              r.actorId === null
                ? "crew"
                : (runActors.get(r.actorId)?.username ?? "crew");
            const stop = stopForm(ctx, repo, r);
            return row({
              ...(stop
                ? {}
                : { href: `${repoBase(repo)}/runs/${r.id}`, nav: true }),
              lead: icon(r.state === "running" ? "loader" : "clock"),
              title: html`<a href="${repoBase(repo)}/runs/${r.id}"
                >${who} · ${repo.name}</a
              >`,
              meta: html`${r.state === "running"
                ? "working"
                : "waiting"}${r.startedAt
                ? html` since ${time(r.startedAt)}`
                : null}`,
              ...(stop
                ? {
                    trail: html`<span class="studio-ask-actions"
                      >${stop}</span
                    >`,
                  }
                : {}),
            });
          }),
          {
            head: html`${icon("activity")}
              <h2>Happening now</h2>`,
          },
        );

  const body = html`<div class="dash">
    <div class="dash-main stack">${asks} ${apps}</div>
    <aside class="dash-rail stack">
      ${now} ${onYouCard(ctx, user) ?? null}
    </aside>
  </div>`;
  return page({
    ctx,
    title: "Studio",
    body,
    styleCss: studioCss,
    scriptJs: `${liveClientJs}\n${asksJs}`,
  });
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
function asksPanel(
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

/** The apps a person can see, as repositories, with their records. */
function appsOf(ctx: Ctx, user: User) {
  const repos = listReposVisibleTo(ctx.app.db, user, { limit: 200 });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  return { repos: repos.filter((r) => records.has(r.id)), records };
}

// ---- actions ----

/** POST /:owner/:name/tell  { text } — a sentence becomes work. */
export async function tellSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, base, {
      tone: "danger",
      message: "Say something first.",
    });
  const told = await tellCrew(ctx.app, ctx.auth.user, repo, text);
  if (!told.ok)
    return flashTo(ctx, base, {
      tone: "danger",
      message: "That could not be told.",
    });
  const { routed } = told.value;
  if (routed === undefined)
    return flashTo(ctx, base, {
      message: `Told. Nobody is on the crew to take it yet — add someone under Settings → Crew.`,
    });
  const builder = routed.builder;
  return flashTo(ctx, base, {
    message: `${builder.user.username} is on it — ${routed.size} ${routed.kind}${routed.by === "rule" ? "" : `, ${routed.by} decided in ${routed.ms} ms`}. Watch it work below.`,
  });
}

/** POST /:owner/:name/pulls/:number/ship — land a green change. */
export async function shipSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  if (!pull) return notFoundPage(ctx);
  const merged = await mergePull(ctx.app, ctx.auth.user, repo, pull, "squash");
  // A conflict is never the person's to fix: the pull's agent brings the
  // branch up to date, and the pull comes back green, or lands on its own.
  if (
    !merged.ok &&
    typeof merged.error !== "string" &&
    merged.error.kind === "conflict"
  ) {
    const who = bringUpToDate(ctx.app, repo, pull, merged.error.files);
    return flashOrJson(ctx, base, {
      tone: "danger" as const,
      message:
        who === undefined
          ? `It conflicts with main (${merged.error.files.join(", ")}) and the crew has already tried its limit; say what to do on the pull.`
          : `It conflicts with main (${merged.error.files.join(", ")}); ${who} is bringing it up to date${repo.autonomy === "autonomous" ? ", then it lands on its own" : ", then it comes back to you"}.`,
    });
  }
  return flashOrJson(ctx, base, {
    ...(merged.ok
      ? { message: `Shipped "${pull.title}". Production is redeploying.` }
      : {
          tone: "danger" as const,
          message: `That could not ship: ${mergeWords(merged.error)}.`,
        }),
  });
}

/** POST /:owner/:name/pulls/:number/say  { text } — feedback to the crew. */
export async function saySubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const number = Number(ctx.params.number);
  const pull = Number.isInteger(number)
    ? getPull(ctx.app.db, repo.id, number)
    : undefined;
  if (!pull) return notFoundPage(ctx);
  const text = field(form, "text").trim();
  if (text === "")
    return flashTo(ctx, base, {
      tone: "danger",
      message: "Say something first.",
    });
  const said = addComment(ctx.app, ctx.auth.user, repo, pull, text);
  return flashOrJson(ctx, base, {
    ...(said.ok
      ? { message: `Told ${pull.authorName}. It picks the change back up.` }
      : { tone: "danger" as const, message: "That could not be said." }),
  });
}

/**
 * POST /studio/asks  { ask*, action, back } — one decision for several asks.
 * Each is the same act as its row's own button. An ask that is gone, or
 * never took this action, is skipped and counted, never guessed at.
 */
export async function asksSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = backTo(ctx, field(form, "back"));
  const action = field(form, "action");
  const picked = [
    ...new Set(
      form.getAll("ask").filter((v): v is string => typeof v === "string"),
    ),
  ];
  if (!isBulkAction(action) || picked.length === 0)
    return flashOrJson(ctx, back, {
      tone: "danger",
      message: "Pick some asks, and what to do with them.",
    });
  // The asks as they stand now, not as the page had them.
  const asks = new Map(
    decisionsFor(ctx, appsOf(ctx, user).repos).map((d) => [d.id, d]),
  );
  const done: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const id of picked) {
    const d = asks.get(id);
    if (d?.pull === undefined || !takes(d, action)) {
      skipped.push(id);
      continue;
    }
    const r =
      action === "ship"
        ? await mergePull(ctx.app, user, d.repo, d.pull, "squash")
        : await setIssueStateThrough(ctx.app, user, d.repo, d.pull, "closed");
    (r.ok ? done : failed).push(id);
  }
  const tally = [`${BULK[action].done} ${done.length}`];
  if (skipped.length > 0) tally.push(`skipped ${skipped.length}`);
  if (failed.length > 0) tally.push(`could not ${action} ${failed.length}`);
  return flashOrJson(
    ctx,
    back,
    {
      ...(done.length === 0 ? { tone: "danger" as const } : {}),
      message: tally.join(" · "),
    },
    { done, skipped, failed },
  );
}

/** Where a form sends a person back: what it said, else the referer, else
 * home — and never off this forge. */
function backTo(ctx: Ctx, said: string): string {
  const back = said || ctx.request.headers.get("referer") || "/";
  return (back.startsWith("/") && !back.startsWith("//")) ||
    back.startsWith(`${ctx.url.origin}/`)
    ? back
    : "/";
}

/** POST /mode  { mode } — studio or dev, for this browser. */
export async function modeSubmit(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const choice = field(form, "mode");
  const secure = ctx.url.protocol === "https:";
  return redirect(
    backTo(ctx, field(form, "back")),
    modeCookie(isMode(choice) ? choice : undefined, secure),
  );
}

/**
 * An action in the bar shows only while every checked ask takes it, and a
 * note when none does — from the same table the route enforces, so the
 * page cannot offer what the server would skip. CSS alone: it holds with
 * scripts off.
 */
const bulkCss = ((): string => {
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

export const studioCss = /* css */ `
.studio { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 22px; margin-top: 16px; }
@media (max-width: 860px) { .studio { grid-template-columns: 1fr; } }
.studio-main { display: grid; gap: 18px; }
.studio-preview { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--muted); }
.studio-preview-head { display: flex; align-items: center; gap: 12px; }
.studio-live { font-family: var(--mono); font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
.studio-live[data-state="running"] { color: var(--merged); border-color: var(--merged); }
.studio-live[data-state="failed"] { color: var(--danger, #c33); }
.studio-tell textarea { min-height: 72px; resize: vertical; }
.studio-tell .bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.studio-head h1 { display: flex; align-items: center; gap: 10px; }
/* The facts under the title take the whole line; the two buttons that act
   on production sit with the rest, each in its own POST form. */
.studio-head .env-facts { margin-top: 2px; }
.studio-head form { display: inline-flex; }
.badge[data-variant="accent"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 34%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.badge[data-word="working"] svg { animation: spin 1.1s linear infinite; }
.studio-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.studio-list li { display: grid; grid-template-columns: 18px 84px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; }
.studio-list li svg { vertical-align: -3px; }
.studio-who { font-weight: 600; }
.studio-word { font-family: var(--mono); font-size: 11.5px; opacity: .8; white-space: nowrap; }
.row-meta .studio-word { font-family: inherit; font-size: inherit; opacity: 1; font-weight: 560; }
.studio-list li[data-word="working"] .studio-word { color: var(--accent); opacity: 1; }
.studio-list li[data-word="look"] .studio-word { color: var(--merged); opacity: 1; }
.studio-list li[data-word="stopped"] .studio-word { color: var(--danger, #c33); opacity: 1; }
.studio-ask-actions { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.studio-lean { margin-left: 2px; }
.studio-asks .row-lead { gap: 8px; }
.studio-ask-pick { accent-color: var(--accent); margin: 0; width: 13px; height: 13px; opacity: .6; }
.studio-ask-pick:checked, .studio-ask-pick:focus-visible, .row:hover .studio-ask-pick { opacity: 1; }
.studio-bulk { display: none; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--border); font-size: 12.5px; background: color-mix(in srgb, var(--accent) 7%, var(--card)); }
.studio-asks:has([name="ask"]:checked) .studio-bulk { display: flex; }
.studio-bulk-count { font-weight: 550; font-variant-numeric: tabular-nums; }
.studio-bulk-none { display: none; }
.studio-asks li[data-busy] { opacity: .6; }
.studio-asks li[data-busy] .studio-ask-actions { visibility: hidden; }
.studio-asks li[data-busy] .row-lead svg { display: none; }
.studio-asks li[data-busy] .row-lead::after { content: ""; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
.studio-ask-note { color: var(--danger, #c33); }
${bulkCss}
.studio-rail { display: grid; gap: 18px; align-content: start; }
.studio-rail h3 { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; opacity: .7; margin: 0 0 6px; font-weight: 600; }
.studio-crew { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; font-size: 13.5px; }
.studio-crew li { display: grid; grid-template-columns: 74px 1fr; gap: 8px; }
.studio-crew li b { font-weight: 600; }
.studio-crew li span { opacity: .85; }
`;
