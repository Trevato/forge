/**
 * Runs on the web (docs/APPS.md): a repository's runs, one run's log —
 * tailed live where there is a script, refreshed where there is not — and
 * the cancel button. A run is as visible as the code it ran on, so every
 * page here reads through the run actions, which answer `not_found` for a
 * repository the viewer may not see.
 *
 * `/runs/:id` is the short door the proxy's "not running" page knocks on:
 * it finds the run's repository and sends the reader to the page above, or
 * to the one 404 — and an anonymous visitor to sign in first, whatever the
 * id, so the redirect itself says nothing about what exists.
 */

import {
  cancelRepoRun,
  listRepoRuns,
  runLog,
  steerRepoRun,
} from "../../actions/runs.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { getIssueById, getIssuesByIds, type Issue } from "../../core/issues.ts";
import { canRead, canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { getRun, isTerminal, type Run, type RunKind } from "../../core/runs.ts";
import { getUserById, getUsersByIds, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { runLogJs } from "../client.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { studioRun, studioRuns } from "./studio.ts";
import {
  btn,
  empty,
  icon,
  listCard,
  pager,
  row,
  runStateBadge,
  seg,
  sha,
  time,
} from "../ui.ts";

// ---- words ----

/** The pull a preview environment is for, from its name; production has none. */
const envNumber = (env: string): number | undefined =>
  env.startsWith("pull-") ? Number(env.slice(5)) : undefined;

/**
 * What a run is, in a few words, naming the pull or issue it is about:
 * `Deploy production`, `Deploy preview #3 Say hello`, `bot on #1 Do a
 * thing`. The issue arrives from one grouped read for the whole list.
 */
export function runTitle(
  run: Run,
  actor: string | undefined,
  issue: Issue | undefined,
): string {
  const about =
    issue === undefined
      ? (() => {
          const number = envNumber(run.env);
          return number === undefined ? "" : `#${number}`;
        })()
      : `#${issue.number} ${issue.title}`;
  if (run.kind === "deploy")
    return about === "" ? "Deploy production" : `Deploy preview ${about}`;
  const who = actor ?? "an agent";
  return about === "" ? `${who} at work` : `${who} on ${about}`;
}

const REASONS: Record<string, string> = {
  boot: "on boot",
  enabled: "when the app was enabled",
  push: "after a push",
  merge: "after a merge",
  opened: "when the pull opened",
  redeploy: "redeployed by hand",
  restart: "restarted after the process exited",
  assigned: "assigned",
  feedback: "after feedback",
  check_failed: "after a failed check",
  conflict: "after main moved",
  review: "the reviewer's pass",
};

/** Why a run exists, as a phrase that follows its title. */
export const reasonWords = (reason: string): string =>
  REASONS[reason] ?? reason;

/** Dollars, two places — a run's spend is a small number read at a glance. */
export const costText = (usd: number): string => `$${usd.toFixed(2)}`;

/** `12s`, `3m 4s`, `1h 2m` — how long a run took, or has taken so far. */
/**
 * What kind of line a run wrote: a tool the agent reached for (`→ Bash …`),
 * a word from the forge itself (cloning, pushing, what the model cost), or
 * the agent speaking. The script that appends live lines sorts them the
 * same way, so a page and its stream look alike.
 */
export type LineKind = "tool" | "forge" | "say" | "you";

const FORGE_LINE =
  /^(claude:|done:|failed:|paused|declined:|cloning |branch |forked |pushing |push refused|clone kept|nothing to propose|opened pull|updated pull|committed the|could not|checking out|deploy |data: |\$ |session |the session|interrupted|passed in|install |test |start |ready |process )/;

export function lineKind(line: string): LineKind {
  if (line.startsWith("→ ")) return "tool";
  if (line.startsWith("you: ")) return "you";
  if (FORGE_LINE.test(line)) return "forge";
  return "say";
}

/** One line of a run's log, as the page draws it. */
export function logLine(line: string, who = "agent"): Html {
  const kind = lineKind(line);
  if (kind === "you")
    return html`<div class="ln ln-you">
      <span class="who">you</span><span class="txt">${line.slice(5)}</span>
    </div>`;
  if (kind === "tool") {
    const rest = line.slice(2);
    const at = rest.indexOf(" ");
    const tool = at === -1 ? rest : rest.slice(0, at);
    const args = at === -1 ? "" : rest.slice(at + 1);
    return html`<div class="ln ln-tool">
      <span class="who"></span><span class="txt"><b>${tool}</b> ${args}</span>
    </div>`;
  }
  if (kind === "forge")
    return html`<div class="ln ln-forge">
      <span class="who">forge</span><span class="txt">${line}</span>
    </div>`;
  return html`<div class="ln ln-say">
    <span class="who">${who}</span><span class="txt">${line}</span>
  </div>`;
}

export function durationText(run: Run): string | undefined {
  if (run.startedAt === null) return undefined;
  const end = run.finishedAt === null ? Date.now() : Date.parse(run.finishedAt);
  const seconds = Math.max(
    0,
    Math.round((end - Date.parse(run.startedAt)) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Every actor the runs name, in one read. */
export function actorsFor(ctx: Ctx, runs: readonly Run[]): Map<string, User> {
  return getUsersByIds(
    ctx.app.db,
    runs.map((run) => run.actorId ?? "").filter(Boolean),
  );
}

/** Every pull or issue the runs are about, in one read. */
export function issuesFor(ctx: Ctx, runs: readonly Run[]): Map<string, Issue> {
  return getIssuesByIds(
    ctx.app.db,
    runs.map((run) => run.issueId ?? "").filter(Boolean),
  );
}

/** The run's title, with both grouped reads resolved. */
export function runTitleFrom(
  run: Run,
  actors: ReadonlyMap<string, User>,
  issues: ReadonlyMap<string, Issue>,
): string {
  const actor = run.actorId === null ? undefined : actors.get(run.actorId);
  const issue = run.issueId === null ? undefined : issues.get(run.issueId);
  return runTitle(run, actor?.username, issue);
}

const kindIcon = (kind: RunKind) =>
  icon(kind === "agent" ? "bot" : kind === "check" ? "check" : "rocket");

// ---- rows ----

/** One run in a list: what it was, why, how it went, and when. */
export function runRow(
  base: string,
  run: Run,
  actors: ReadonlyMap<string, User>,
  issues: ReadonlyMap<string, Issue>,
): Html {
  const title = runTitleFrom(run, actors, issues);
  const meta = `${reasonWords(run.reason)}${run.summary === "" ? "" : ` · ${run.summary}`}`;
  return row({
    href: `${base}/runs/${run.id}`,
    nav: true,
    lead: kindIcon(run.kind),
    title,
    titleAttr: title,
    meta: html`<span title="${meta}">${meta}</span>`,
    trail: html`${runStateBadge(run.state, run.kind)} ${time(run.createdAt)}`,
  });
}

/**
 * The agent runs about one issue or pull — the crew's side of the story,
 * beside the conversation. Empty when nobody on the crew has touched it.
 */
export function crewActivityCard(ctx: Ctx, repo: Repo, issue: Issue): Html {
  const runs = listRepoRuns(ctx.app, ctx.auth.user, repo, {
    kind: "agent",
    issueId: issue.id,
    limit: 10,
  });
  if (!runs.ok || runs.value.length === 0) return html``;
  const base = repoBase(repo);
  const actors = actorsFor(ctx, runs.value);
  return listCard(
    runs.value.map((run) => {
      const who =
        (run.actorId === null ? undefined : actors.get(run.actorId))
          ?.username ?? "an agent";
      return row({
        href: `${base}/runs/${run.id}`,
        lead: icon("bot"),
        title: html`${who}
          <span class="muted">${reasonWords(run.reason)}</span>`,
        meta: html`<span title="${run.summary}"
          >${run.summary === "" ? "no summary yet" : run.summary}</span
        >`,
        trail: html`${runStateBadge(run.state, "agent")}${when(
          run.costUsd > 0,
          () =>
            html`<span class="num muted small">${costText(run.costUsd)}</span>`,
        )}`,
      });
    }),
    {
      head: html`${icon("bot")}
        <h2>Crew activity</h2>`,
    },
  );
}

// ---- the list ----

const PER_PAGE = 30;

// GET /:owner/:name/runs
export async function runsList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  // In the studio "every run" is the run list in the studio's own words —
  // the same rule `runPage` follows for one run. `?mode=dev` is the
  // one-off way to dev's list without switching the browser.
  const studio =
    ctx.mode === "studio" && ctx.url.searchParams.get("mode") !== "dev";
  if (studio) {
    const record = getAppByRepo(ctx.app.db, repo.id);
    if (record !== undefined) return await studioRuns(ctx, repo, record);
  }
  const base = repoBase(repo);
  const q = ctx.url.searchParams;
  const kindRaw = q.get("kind");
  const kind: RunKind | undefined =
    kindRaw === "deploy" || kindRaw === "agent" || kindRaw === "check"
      ? kindRaw
      : undefined;
  const cursor = q.get("cursor") ?? "";

  const listed = listRepoRuns(ctx.app, ctx.auth.user, repo, {
    kind,
    cursor: cursor === "" ? undefined : cursor,
    limit: PER_PAGE + 1,
  });
  if (!listed.ok) return notFoundPage(ctx);
  const shown = listed.value.slice(0, PER_PAGE);
  const last = shown[shown.length - 1];
  const more = listed.value.length > PER_PAGE && last !== undefined;
  const actors = actorsFor(ctx, shown);
  const issues = issuesFor(ctx, shown);

  const href = (which: RunKind | undefined, next?: string): string => {
    const p = new URLSearchParams();
    if (which !== undefined) p.set("kind", which);
    if (next !== undefined) p.set("cursor", next);
    const text = p.toString();
    return text === "" ? `${base}/runs` : `${base}/runs?${text}`;
  };

  const list =
    shown.length === 0
      ? empty({
          icon: "activity",
          title:
            kind === "agent"
              ? "No agent runs yet"
              : kind === "deploy"
                ? "No deploys yet"
                : kind === "check"
                  ? "No checks yet"
                  : "No runs yet",
          note: "A run is a deploy of an environment, a check of a commit, or an agent working an issue. Each one keeps its log here.",
        })
      : listCard(shown.map((run) => runRow(base, run, actors, issues)));

  const body = html`${repoHeader(ctx, repo, "app", { compact: true })}
    <div class="filters mt">
      ${seg([
        { label: "All", href: href(undefined), current: kind === undefined },
        { label: "Deploys", href: href("deploy"), current: kind === "deploy" },
        { label: "Checks", href: href("check"), current: kind === "check" },
        { label: "Crew", href: href("agent"), current: kind === "agent" },
      ])}
    </div>
    ${list}
    ${pager({
      ...(cursor !== "" ? { prev: href(kind) } : {}),
      ...(more && last ? { next: href(kind, last.id) } : {}),
    })}
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: `Runs · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    scriptJs: liveClientJs,
  });
}

// ---- one run ----

// GET /:owner/:name/runs/:id
export async function runPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const found = runLog(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
  if (!found.ok) return notFoundPage(ctx);
  const { run, lines, truncated } = found.value;
  // In the studio, working is a run: who is on it, the tell it came from,
  // what it has cost, and the box to steer it — the same rule `repoHome`
  // and `pullPage` follow. `?mode=dev` is the one-off way to the transcript
  // dev already renders, without switching the browser.
  const studio =
    ctx.mode === "studio" && ctx.url.searchParams.get("mode") !== "dev";
  if (studio && getAppByRepo(ctx.app.db, repo.id) !== undefined)
    return await studioRun(ctx, repo, run, lines, truncated);
  const base = repoBase(repo);
  const actor =
    run.actorId === null ? undefined : getUserById(ctx.app.db, run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(ctx.app.db, run.issueId);
  const title = runTitle(run, actor?.username, issue);
  const unfinished = !isTerminal(run.state);
  const writer = canWrite(ctx.app.db, repo, ctx.auth.user);
  const duration = durationText(run);
  const stream = `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/log?follow=1`;
  const who = actor?.username ?? "agent";

  const body = html`${repoHeader(ctx, repo, "app", {
      compact: true,
      ownTitle: true,
    })}
    <div class="issue-head">
      <h1>${title}</h1>
      <div class="issue-meta">
        <span id="run-state" data-kind="${run.kind}"
          >${runStateBadge(run.state, run.kind)}</span
        >
        <span
          >${run.kind === "agent"
            ? "agent run"
            : run.kind === "check"
              ? "check"
              : "deploy"}
          · ${reasonWords(run.reason)}</span
        >
        ${when(run.commitOid !== "", () =>
          sha(run.commitOid, `${base}/commit/${run.commitOid}`),
        )}
        ${when(
          run.kind === "agent" && run.branch !== "",
          () => html`<span class="mono">${run.branch}</span>`,
        )}
        ${when(
          issue,
          (i) =>
            html`<a
              href="${base}/${i.kind === "pull"
                ? "pulls"
                : "issues"}/${i.number}"
              >#${i.number} ${i.title}</a
            >`,
        )}
        <span class="num" id="run-cost" ${run.costUsd > 0 ? null : html`hidden`}
          >${costText(run.costUsd)} spent</span
        >
        <span class="num" id="run-turns" ${run.turns > 0 ? null : html`hidden`}
          >${run.turns} turn${run.turns === 1 ? "" : "s"}</span
        >
        <span>queued ${time(run.createdAt)}</span>
        ${when(
          duration,
          (d) =>
            html`<span
              class="num"
              id="run-elapsed"
              data-started="${run.startedAt ?? ""}"
              data-finished="${run.finishedAt ?? ""}"
              >${run.finishedAt === null ? "running for" : "took"} ${d}</span
            >`,
        )}
      </div>
    </div>
    <p class="run-summary" id="run-summary">${run.summary}</p>
    ${when(
      writer && unfinished && run.kind === "agent" && issue === undefined,
      () =>
        html`<div class="run-actions" id="run-cancel">
          <form method="post" action="${base}/runs/${run.id}/cancel">
            ${btn("Stop", { size: "sm", variant: "outline", icon: "square" })}
          </form>
        </div>`,
    )}
    ${when(
      writer && unfinished && run.kind !== "agent",
      () =>
        html`<div class="run-actions" id="run-cancel">
          <form method="post" action="${base}/runs/${run.id}/cancel">
            ${btn("Cancel run", {
              size: "sm",
              variant: "outline",
              icon: "square",
            })}
          </form>
        </div>`,
    )}
    ${when(
      truncated,
      () =>
        html`<p class="muted small mb">
          Showing the last 512 KB of the log; the file on disk has the rest.
        </p>`,
    )}
    ${when(
      lines.length === 0,
      () =>
        html`<p class="muted small" id="run-empty">
          Nothing has been logged yet.
        </p>`,
    )}
    <div class="run-live" id="run-live" data-state="${run.state}">
      <div
        class="run-log"
        id="run-log"
        data-who="${who}"
        ${unfinished ? html`data-stream="${stream}"` : null}
      >
        ${lines.map((l) => logLine(l, who))}
        ${when(
          run.state === "running",
          () =>
            html`<div class="ln ln-pulse" id="run-pulse">
              <span class="who">${who}</span
              ><span class="txt"><i></i><i></i><i></i></span>
            </div>`,
        )}
        <button type="button" class="run-jump" id="run-jump" hidden>
          newer below
        </button>
      </div>
      ${when(
        writer && run.kind === "agent" && issue !== undefined,
        () =>
          html`<form
            class="run-steer"
            id="run-steer"
            method="post"
            action="${base}/runs/${run.id}/steer"
            data-api="/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/steer"
            data-running="${run.state === "running" ? "1" : "0"}"
          >
            <label class="sr-only" for="steer-text"
              >Say something to ${who}</label
            >
            <textarea
              class="input"
              id="steer-text"
              name="text"
              rows="1"
              required
              placeholder="${run.state === "running"
                ? `Steer ${who} — it hears you at its next step`
                : `Tell ${who} for its next run`}"
            ></textarea>
            <div class="bar">
              <span class="muted small" id="run-steer-note"
                >${run.state === "running"
                  ? "Heard after the step it is on. Enter sends; every word is kept in the log."
                  : "The run is over; this goes on the conversation and starts a run."}</span
              >
              <span class="spacer"></span>
              ${when(
                unfinished,
                () =>
                  html`<button
                    type="submit"
                    class="btn"
                    data-size="sm"
                    data-variant="outline"
                    id="run-stop"
                    formaction="${base}/runs/${run.id}/cancel"
                    formnovalidate
                  >
                    ${run.state === "running" ? "Stop" : "Cancel"}
                  </button>`,
              )}
              ${btn("Send", { size: "sm", variant: "primary", type: "submit" })}
            </div>
          </form>`,
      )}
    </div>`;

  return page({
    ctx,
    title: `${title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    scriptJs: runLogJs,
    // The no-script half of a live log: while the run is going, the page
    // refreshes itself; the script above removes this the moment it runs.
    ...(unfinished ? { refresh: { seconds: 5 } } : {}),
  });
}

// POST /:owner/:name/runs/:id/steer  { text }
export async function runSteer(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = ctx.params.id ?? "";
  const dest = `${repoBase(repo)}/runs/${id}`;
  const steered = steerRepoRun(
    ctx.app,
    ctx.auth.user,
    repo,
    id,
    field(form, "text"),
  );
  if (!steered.ok) {
    if (steered.error === "not_found") return notFoundPage(ctx);
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        steered.error === "empty"
          ? "Say something first."
          : steered.error === "not_agent"
            ? "Only an agent's run can be steered."
            : "You need write access to steer a run.",
    });
  }
  return flashTo(ctx, dest, {
    message:
      steered.value === "sent"
        ? "Sent. The agent hears it at its next step."
        : "The run had nobody listening, so it went on the conversation; a run starts from it.",
  });
}

// GET /runs/:id — the run's own page, wherever it lives.
export function runRedirect(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const run = getRun(ctx.app.db, ctx.params.id ?? "");
  const repo =
    run === undefined ? undefined : getRepoById(ctx.app.db, run.repoId);
  if (!run || !repo || !canRead(ctx.app.db, repo, ctx.auth.user))
    return notFoundPage(ctx);
  return redirect(`${repoBase(repo)}/runs/${run.id}`);
}

// POST /:owner/:name/runs/:id/cancel
export async function runCancel(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = ctx.params.id ?? "";
  const dest = `${repoBase(repo)}/runs/${id}`;
  const cancelled = cancelRepoRun(ctx.app, ctx.auth.user, repo, id);
  if (!cancelled.ok) {
    if (cancelled.error === "not_found") return notFoundPage(ctx);
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        cancelled.error === "finished"
          ? "That run had already finished."
          : "You need write access to cancel a run.",
    });
  }
  return flashTo(ctx, dest, { message: "Run cancelled." });
}
