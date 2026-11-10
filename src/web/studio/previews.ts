/**
 * Every environment an app has, as the studio draws them: the head card for
 * what production is doing, and one row per open pull for the preview a
 * change can be looked at in. Both come from the runtime's own `status()` in
 * one read, so the list costs nothing extra as pulls pile up, and both are
 * drawn by the one function the page's first paint and the live fragment a
 * deploy event refreshes (`appStateFragment`) share.
 */

import { HELP_BUILD } from "../../core/contribute.ts";
import { lacks } from "../../core/roles.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { sealedScope } from "../../core/sealed.ts";
import { terminalFor } from "../../actions/apps.ts";
import { envPull, previewEnv } from "../../apps/data.ts";
import { appOnboardingLine } from "../../apps/onboarding.ts";
import {
  appsRuntime,
  type AppsRuntime,
  type EnvStatus, envsFor } from "../../apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import { listPulls, type Pull } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { latestRunsForIssues, listRuns, type Run } from "../../core/runs.ts";
import type { Ctx } from "../../http/context.ts";
import { readRunLogTail } from "../../runs/log.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { testsClause } from "./words.ts";
import { html, when, type Html } from "../html.ts";
import { fragment, missingFragment } from "../layout.ts";
import { onboardingRow } from "../onboarding_row.ts";
import { hasHistory } from "./fresh.ts";
import {
  badge,
  btn,
  dormantNote,
  envActions,
  envFacts,
  envLine,
  envPhrase,
  icon,
  listCard,
  previewDataNote,
  row,
  terminalLine,
} from "../ui.ts";
import { lookNow } from "../pages/looks.ts";
import { testCopyLink } from "../pages/apps.ts";
import { shownProduction } from "../../core/forge_repo.ts";
import { LOG_TAIL_CAP, logBox, runVoice } from "./log.ts";

/**
 * The primary button, offered only once production answers — a preview
 * whose tests failed is still serving, so `running` is enough, `error`
 * clear or not (#118). Anything short of that gets the same button shape,
 * disabled, with the reason it is not there in its title: never a link to
 * a host nothing is serving yet.
 */
function openAppBtn(base: string, env: EnvStatus | undefined, forge = false): Html {
  // The forge's own source opens the forge, which is up whatever its test copy is doing.
  if (forge || env?.state === "running")
    return btn("Open the app", {
      href: `${base}/app/production/open`,
      variant: "primary",
      icon: "external",
    });
  const reason =
    env === undefined || env.state === "stopped"
      ? "Nothing is running yet. The app starts when it is deployed."
      : env.state === "deploying"
        ? "Still deploying"
        : "The last deploy failed";
  return btn("Open the app", {
    variant: "primary",
    icon: "external",
    disabled: true,
    title: reason,
  });
}

/** The studio's own words for a preview, whatever its check says — always
 * `envPhrase`'s, so this row never invents a second vocabulary. */
function previewBadge(env: EnvStatus | undefined): Html {
  const { word, tone } = envPhrase(env);
  const ic =
    env?.state === "running"
      ? "play"
      : env?.state === "deploying"
        ? "loader"
        : "square";
  return badge(word, { tone, icon: ic });
}

/** The tests clause for a serving preview, only when the green check is of
 * the very commit being served — a stale check says nothing. */
export function previewVerdict(
  env: EnvStatus | undefined,
  check: Run | undefined,
): string | undefined {
  if (env?.state !== "running" || check?.state !== "ok") return undefined;
  if (check.commitOid !== env.commitOid) return undefined;
  return testsClause(check) || undefined;
}

/**
 * One open pull's preview, as one row: its host is the click, its state is
 * the badge, and its meta line says what the change page's Preview card
 * says, in `envLine`'s words — commit, `live Ns after the push`, `up …`,
 * the deploy run — then any sentence the deployment has of its own. A check
 * still running or a check that failed says so right there; the row never
 * hides a preview that is serving.
 *
 * Once there is an environment its facts carry links of their own, so the
 * row is no longer one link — the host is, and `j`/`k` still land on the
 * row and open it. A writer also gets the preview's Redeploy and Stop
 * beside the badge. The meta line always starts with `#N title`: the live
 * client (`live.ts`) keys a row's announcement on it.
 */
function previewRow(
  base: string,
  runtime: AppsRuntime | undefined,
  record: AppRecord,
  pull: Pull,
  env: EnvStatus | undefined,
  writer: boolean,
  check: Run | undefined,
): Html {
  const href =
    runtime === undefined
      ? undefined
      : `${base}/app/${previewEnv(pull.number)}/open`;
  const bits: Html[] = [html`#${pull.number} ${pull.title}`];
  if (env !== undefined) bits.push(...envLine(base, env));
  // A serving preview whose deploy finished green says what its tests did.
  const say =
    env?.error ?? env?.failedDeploy?.error ?? env?.note ?? previewVerdict(env, check);
  if (say) bits.push(html`${say}`);
  const asleep = env === undefined ? null : dormantNote(env);
  if (asleep !== null) bits.push(asleep);
  if (env !== undefined) {
    const dataNote = previewDataNote(record.previewData, pull.createdAt);
    if (dataNote !== null) bits.push(dataNote);
  }
  const meta = bits.reduce((a, b) => html`${a} · ${b}`);
  if (env !== undefined)
    return row({
      ...(href === undefined ? {} : { nav: true }),
      lead: icon("rocket"),
      // Named for its pull, not its host: the address is the link, and a
      // visitor reads "Preview of #N" where an internal name said nothing.
      title:
        href === undefined
          ? `#${pull.number} ${pull.title}`
          : html`<a href="${href}">Preview of #${pull.number}</a>`,
      meta,
      trail: writer
        ? html`${previewBadge(env)} ${envActions(base, env, writer)}`
        : previewBadge(env),
    });
  return row({
    ...(href === undefined ? {} : { href, nav: true }),
    lead: icon("rocket"),
    title: href === undefined ? `#${pull.number} ${pull.title}` : `Preview of #${pull.number}`,
    meta,
    trail: previewBadge(env),
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
  writer: boolean,
  checks: ReadonlyMap<string, Run>,
): Html | null {
  if (openPulls.length === 0) return null;
  const byPull = new Map(
    envs
      .filter((e) => e.env !== "production")
      .map((e) => [envPull(e.env), e] as const),
  );
  return listCard(
    openPulls.map((p) =>
      previewRow(base, runtime, record, p, byPull.get(p.number), writer, checks.get(p.id)),
    ),
    {
      head: html`${icon("rocket")}
        <h2>Previews</h2>`,
    },
  );
}

/**
 * Production, tailed: while its deploy is running, and for as long as it
 * keeps running after (#284) — its process's stdout and stderr keep landing
 * in the same run's log past the swap-in (`apps/process.ts` pumps them for
 * the process's own life, not just its start) — the head card gets a peek
 * at it, the same shape a running agent run gets beside its row. No agent
 * run may already have the crew's own tail (`studio/app.ts`'s "Now" panel):
 * the agent's run wins the one stream this page opens when both are going,
 * since it is the crew's own answer to something asked, where production's
 * own voice is passive by comparison. When "Now" would otherwise sit empty
 * while a deploy is the thing going, its own empty state points back up at
 * this tail rather than opening a second stream of the same lines.
 *
 * Once the deploy has swapped in, the lines are the app's own — never the
 * deploy's, whose word (`envPhrase`) has already moved on to "live" — and
 * an app's stdout can carry anything the owner never meant for a stranger,
 * so only a viewer who can see the owner's facts is shown it at all —
 * a deploy's too, as it is a log (`mayReadRunLog`).
 */
function productionTail(
  ctx: Ctx,
  repo: Repo,
  production: EnvStatus | undefined,
  writer: boolean,
): { box: Html | undefined; deploying: boolean } {
  const none = { box: undefined, deploying: false };
  if (production === undefined || production.runId === undefined) return none;
  const deploying = production.state === "deploying";
  if (!deploying && production.state !== "running") return none;
  if (!writer) return none;
  const agentBusy = listRuns(ctx.app.db, repo.id, {
    kind: "agent",
    limit: 8,
  }).some((r) => r.state === "running");
  if (agentBusy) return none;
  const stream = `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${production.runId}/log?follow=1`;
  if (deploying)
    return {
      box: logBox({
        id: "app-run-tail",
        who: runVoice("deploy", true, { name: undefined, isAgent: true }),
        cap: LOG_TAIL_CAP,
        lines: readRunLogTail(ctx.app.config.dataDir, production.runId, LOG_TAIL_CAP)
          .lines,
        stream,
        className: "log-tail",
      }),
      deploying: true,
    };
  const { lines } = readRunLogTail(
    ctx.app.config.dataDir,
    production.runId,
    LOG_TAIL_CAP,
  );
  if (lines.length === 0)
    return {
      box: html`<p class="muted small" id="app-run-tail">
        Production is quiet — it hasn't said anything yet.
      </p>`,
      deploying: false,
    };
  return {
    box: logBox({
      id: "app-run-tail",
      who: "the app",
      cap: LOG_TAIL_CAP,
      lines,
      stream,
      className: "log-tail",
    }),
    deploying: false,
  };
}

/**
 * The head card and the previews list: what production is doing, and every
 * open pull's own environment. One function, called for the page's first
 * paint and for the fragment a deploy event refreshes in place
 * (`appStateFragment`) — the two never draw two copies of the same markup.
 */
export function appPanels(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  openPulls: readonly Pull[],
): {
  head: Html;
  previews: Html | null;
  deployTailing: boolean;
  /** A new app that has not run yet: its page shows only its progress. */
  fresh: boolean;
  /** Anything ever shipped here, or (for a viewer who sees them) a run taken. */
  history: boolean;
} {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const runtime = appsRuntime(ctx.app);
  const envs: EnvStatus[] = envsFor(ctx.app, ctx.auth.user, record);
  const writer = canSeeOwnerFacts(db, repo, ctx.auth.user);
  const checks = latestRunsForIssues(db, openPulls.map((p) => p.id));
  const production = envs.find((e) => e.env === "production");
  // Until production has a deploy of its own to speak of, a new app's facts
  // row says where it stands instead (`apps/onboarding.ts`).
  const onboarding = production?.runId === undefined ? appOnboardingLine(ctx.app, repo, ctx.auth.user) : undefined;
  const history = hasHistory(db, repo.id, writer);
  const fresh = onboarding !== undefined && !history;
  // A fresh app's pull is already the Now row; a second list would say it twice.
  const previews = fresh ? null : previewsPanel(base, runtime, record, openPulls, envs, writer, checks);
  // The forge's own source shows the forge as its production; the app is its test copy.
  const { url, copy } = shownProduction(ctx.app, repo, runtime?.urlFor(record, "production"));
  const tail = productionTail(ctx, repo, production, writer);
  // The state in one word, and under it the facts — why it is not up, and
  // the deploy whose log says the rest.
  const live = envPhrase(production);
  const head = html`<div class="page-head">
    <div class="stack stack-tight">
      <h1 class="bar">
        ${repo.name}
        ${badge(
          live.word,
          live.tone === "default"
            ? { variant: "secondary" }
            : { tone: live.tone },
        )}
      </h1>
      ${when(repo.description || url !== undefined || copy !== undefined, () => html`<p class="muted">
        ${when(repo.description, (d) => html`${d}`)}
        ${url === undefined
          ? null
          : copy !== undefined || production?.state === "running"
            ? html`${repo.description ? "· " : ""}<a href="${base}/app/production/open" class="mono"
                  >${url.replace(/^https?:\/\//, "")}</a
                >`
            : html`${repo.description ? "· " : ""}<span class="mono">${url.replace(/^https?:\/\//, "")}</span>`}
        ${when(copy, (c) => html`${repo.description || url !== undefined ? "· " : ""}${testCopyLink(c)}`)}
      </p>`)}
      ${onboarding === undefined
        ? when(production, (env) => envFacts(base, env))
        : onboardingRow(onboarding)}
      ${when(writer && !fresh, () =>
        terminalLine(
          terminalFor(ctx.app, record, "production", production),
          ctx.app.config.sshHostKey,
        ),
      )}
      ${tail.box ?? null}
    </div>
    <span class="spacer"></span>
    ${lookNow(ctx, repo, record)}
    ${openAppBtn(base, production, copy !== undefined)}
    ${when(!writer, () =>
      btn(ctx.auth.user !== undefined && lacks(db, ctx.auth.user, "make_it_yours") ? HELP_BUILD : "Make it yours", { href: `${base}/make-it-yours`, icon: "fork" }),
    )}
    ${when(production, (env) => envActions(base, env, writer))}
  </div>`;
  return {
    head,
    previews,
    deployTailing: tail.deploying,
    fresh,
    history,
  };
}

/**
 * GET /:owner/:name/app/state — the head card and previews list, bare. The
 * studio page's own live client (`live.ts`) fetches this on a deploy run
 * event for the app being viewed and swaps the two in place, so a change
 * serving in its preview shows up without a reload. Authorized exactly as
 * the studio page: a viewer who cannot see the app gets the same 404.
 */
export function appStateFragment(ctx: Ctx): Response {
  const req = ctx.request;
  notePhase(req, "session", takeSessionTime(req));
  const repo = timePhase(req, "repo", () => loadRepo(ctx));
  const record = repo && timePhase(req, "record", () => getAppByRepo(ctx.app.db, repo.id));
  if (!repo || !record) return missingFragment(req);
  const openPulls = timePhase(req, "pulls", () =>
    listPulls(ctx.app.db, repo.id, {
      state: "open",
      limit: 10,
      ...sealedScope(ctx.app.db, repo, ctx.auth.user),
    }),
  );
  const { head, previews } = timePhase(req, "panels", () =>
    appPanels(ctx, repo, record, openPulls),
  );
  const rendering = performance.now();
  const res = fragment(html`<div id="app-head">${head}</div>
    <div id="app-previews">${previews}</div>`, { request: req });
  notePhase(req, "render", performance.now() - rendering);
  return res;
}
