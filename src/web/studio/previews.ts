/**
 * Every environment an app has, as the studio draws them: the head card for
 * what production is doing, and one row per open pull for the preview a
 * change can be looked at in. Both come from the runtime's own `status()` in
 * one read, so the list costs nothing extra as pulls pile up, and both are
 * drawn by the one function the page's first paint and the live fragment a
 * deploy event refreshes (`appStateFragment`) share.
 */

import { terminalFor } from "../../actions/apps.ts";
import { envPull, previewEnv } from "../../apps/data.ts";
import {
  appsRuntime,
  type AppsRuntime,
  type EnvState,
  type EnvStatus,
} from "../../apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import { listPulls, type Pull } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { listRuns } from "../../core/runs.ts";
import type { Ctx } from "../../http/context.ts";
import { readRunLog } from "../../runs/log.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, when, type Html } from "../html.ts";
import { fragment } from "../layout.ts";
import {
  badge,
  btn,
  envActions,
  envFacts,
  envPhrase,
  icon,
  listCard,
  row,
  terminalLine,
  time,
} from "../ui.ts";
import { lookNow } from "../pages/looks.ts";
import { LOG_TAIL_CAP, logBox } from "./log.ts";

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

/**
 * Production coming up, tailed: while its deploy is running and no agent
 * run has the crew's own tail already (`studio/app.ts`'s "Now" panel), the
 * head card gets the same peek at the log a running agent run gets beside
 * its row — the app's own first thirty seconds are not a blank page. The
 * agent's run wins the one stream this page opens when both are going: it
 * is the crew's own answer to something asked, where a deploy is often
 * background (a redeploy after an unrelated push), and it is already what
 * "Now" shows.
 */
function deployTail(
  ctx: Ctx,
  repo: Repo,
  production: EnvStatus | undefined,
): Html | undefined {
  if (production?.state !== "deploying" || production.runId === undefined)
    return undefined;
  const agentBusy = listRuns(ctx.app.db, repo.id, {
    kind: "agent",
    limit: 8,
  }).some((r) => r.state === "running");
  if (agentBusy) return undefined;
  return logBox({
    id: "app-run-tail",
    who: "the deploy",
    cap: LOG_TAIL_CAP,
    lines: readRunLog(ctx.app.config.dataDir, production.runId).lines,
    stream: `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${production.runId}/log?follow=1`,
    className: "log-tail",
  });
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
): { head: Html; previews: Html | null; deployTailing: boolean } {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const runtime = appsRuntime(ctx.app);
  const envs: EnvStatus[] = runtime === undefined ? [] : runtime.status(record);
  const previews = previewsPanel(base, runtime, record, openPulls, envs);
  const production = envs.find((e) => e.env === "production");
  const url = runtime?.urlFor(record, "production");
  const writer = canSeeOwnerFacts(db, repo, ctx.auth.user);
  const tail = deployTail(ctx, repo, production);
  // The state in one word, and under it the same facts the App page shows —
  // why it is not up, and the deploy whose log says the rest.
  const live = envPhrase(production);
  const head = html`<div class="page-head studio-head">
    <div class="stack stack-tight">
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
      ${when(writer, () =>
        terminalLine(
          terminalFor(ctx.app, record, "production", production),
          ctx.app.config.sshHostKey,
        ),
      )}
      ${tail ?? null}
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
  return { head, previews, deployTailing: tail !== undefined };
}

/**
 * GET /:owner/:name/app/state — the head card and previews list, bare. The
 * studio page's own live client (`live.ts`) fetches this on a deploy run
 * event for the app being viewed and swaps the two in place, so a change
 * serving in its preview shows up without a reload. Authorized exactly as
 * the studio page: a viewer who cannot see the app gets the same 404.
 */
export function appStateFragment(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return fragment(html``, 404);
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (!record) return fragment(html``, 404);
  const openPulls = listPulls(ctx.app.db, repo.id, {
    state: "open",
    limit: 10,
  });
  const { head, previews } = appPanels(ctx, repo, record, openPulls);
  return fragment(html`<div id="app-head">${head}</div>
    <div id="app-previews">${previews}</div>`);
}
