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

import { crewFace } from "../pixel.ts";
import { steerRefusedWords } from "../../actions/steer_words.ts";
import { readLooks } from "../../checks/looks.ts";
import type { Database } from "bun:sqlite";
import {
  cancelRepoRun,
  listRepoRuns,
  runLog,
  steerRepoRun,
} from "../../actions/runs.ts";
import { getIssuesByIds, type Issue } from "../../core/issues.ts";
import {
  canRead,
  canSeeOwnerFacts,
  getRepoById,
  type Repo,
} from "../../core/repos.ts";
import { getRun, type Run, type RunKind } from "../../core/runs.ts";
import { getUsage, issueUsage } from "../../core/usage.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase, signInFirst } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { badge } from "../ui.ts";
import { flashTo, redirect } from "../layout.ts";
import { runsListPage } from "../studio/lists.ts";
import { runView } from "../studio/run.ts";
import {
  icon,
  listCard,
  row,
  runStateBadge,
  time,
  tokenCount,
} from "../ui.ts";

/**
 * A run's page at a 390 px phone (#9347): its head (title, the issue it is
 * about, summary, what it carries) and everything under the live region
 * break a long word anywhere, so a pasted path or a 300-character token
 * wraps in place and the page never scrolls sideways. The log box itself
 * already wraps and scrolls inside its own bounds (`.run-log`,
 * `style/content.ts`). Ids the page already carries; no new class.
 */
export const RUN_PAGE_CSS = `#run-head, #run-live { overflow-wrap: anywhere; }`;

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
  if (run.kind === "check") {
    const number = issue?.number ?? envNumber(run.env);
    const of = `Check of ${run.commitOid.slice(0, 7)}`;
    return number === undefined ? of : `${of} for #${number}`;
  }
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

/**
 * What the crew's runs on one issue or pull spent altogether: the cost and,
 * beside it, the tokens read and written (`core/usage.ts` `issueUsage`).
 * The owner's facts, like a run's cost — nothing for a reader who cannot
 * write here, and nothing before a run has landed in the ledger.
 */
export function workSpent(ctx: Ctx, repo: Repo, issueId: string): Html {
  if (!canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user)) return html``;
  const used = issueUsage(ctx.app.db, issueId);
  if (used === undefined) return html``;
  return html`<span class="num" id="work-spent"
    >${used.runs} run${used.runs === 1 ? "" : "s"} ·
    ${costText(used.costUsd)} · ${tokenCount(used.tokensIn, "counted")} in ·
    ${tokenCount(used.tokensOut, "counted")} out</span
  >`;
}

/**
 * What a finished agent run read and wrote, in tokens, from the usage ledger
 * (`core/usage.ts`) — counted by the provider, so no tilde. Placed beside the
 * cost, never alone; nothing until the ledger has the run, or when it spent
 * nothing.
 */
export function runTokens(db: Database, run: Run): Html {
  const used = run.kind === "agent" ? getUsage(db, run.id) : undefined;
  if (used === undefined || used.tokensIn + used.tokensOut === 0) return html``;
  return html`<span class="num" id="run-tokens"
    >${tokenCount(used.tokensIn, "counted")} in ·
    ${tokenCount(used.tokensOut, "counted")} out</span
  >`;
}

/**
 * What kind of line a run wrote: a tool the agent reached for (`→ Bash …`),
 * a word from the forge itself (cloning, pushing, what the model cost), or
 * the agent speaking. The script that appends live lines sorts them the
 * same way, so a page and its stream look alike.
 */
export type LineKind = "tool" | "forge" | "say" | "you";

const FORGE_LINE =
  /^(claude:|done:|failed:|paused|declined:|cloning |branch |forked |pushing |push refused|clone kept|nothing to propose|opened pull|updated pull|committed the|could not|checking out|deploy |data: |\$ |session |the session|interrupted|passed in|install |test |start |ready |process |timing: )/;

export function lineKind(line: string): LineKind {
  if (line.startsWith("→ ")) return "tool";
  if (line.startsWith("you: ")) return "you";
  if (FORGE_LINE.test(line)) return "forge";
  return "say";
}

/** One line of a run's log, as the page draws it: §5's row, a badge naming
 * who or what spoke in the lead, the words as its title. The live script in
 * `client.ts` builds the same markup. */
export function logLine(line: string, who = "agent", anchor?: string): Html {
  const kind = lineKind(line);
  if (kind === "tool") {
    const rest = line.slice(2);
    const at = rest.indexOf(" ");
    const tool = at === -1 ? rest : rest.slice(0, at);
    const args = at === -1 ? "" : rest.slice(at + 1);
    return logRow(kind, "tool", html`<b>${tool}</b> ${args}`, undefined, anchor);
  }
  if (kind === "you") return logRow(kind, "you", line.slice(5), "secondary", anchor);
  if (kind === "forge") return logRow(kind, "forge", line, "outline", anchor);
  return logRow(kind, who, line, undefined, anchor);
}

/** The row itself; also the pulse's, in `studio/log.ts`. */
export function logRow(
  kind: string,
  label: string,
  body: Html | string | null,
  variant?: "secondary" | "outline",
  /** The row's `id`, so a link can point at this line (`#L12`). */
  anchor?: string,
): Html {
  const lead = variant === undefined ? badge(label) : badge(label, { variant });
  return html`<div class="row" data-line="${kind}"${anchor === undefined ? null : html` id="${anchor}"`}>
    <span class="row-lead">${lead}</span>
    <span class="row-main"><span class="row-title">${body}</span></span>
  </div>`;
}

/**
 * `0.3s`, `12s`, `3m 4s`, `1h 2m` — how long a run took, or has taken so
 * far. Under ten seconds it names tenths, the way `servedPhrase` (`ui.ts`)
 * already does for a deploy's own arrival — whole seconds there would round
 * a deploy the head card calls "live 0.3s after the push" down to "took 0s".
 */
export function durationText(run: Run): string | undefined {
  if (run.startedAt === null) return undefined;
  const end = run.finishedAt === null ? Date.now() : Date.parse(run.finishedAt);
  const ms = Math.max(0, end - Date.parse(run.startedAt));
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
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

/** A crew member's face for their run, working only while it runs; the kind's icon otherwise. */
function runLead(run: Run, actors: ReadonlyMap<string, User>): Html {
  const who = run.actorId === null ? undefined : actors.get(run.actorId)?.username;
  const face = run.kind === "agent" && who !== undefined ? crewFace(who, run.state === "running" ? "working" : "still", 16, true) : null;
  return face ?? kindIcon(run.kind);
}

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
    lead: runLead(run, actors),
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
        lead: crewFace(who, run.state === "running" ? "working" : "still", 16, true) ?? icon("bot"),
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

// ---- the list and one run ----

// GET /:owner/:name/runs — every run, in the studio's own words, for every
// repository and every viewer (`runsListPage`, `studio/lists.ts`).
export async function runsList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  return await runsListPage(ctx, repo);
}

// GET /:owner/:name/runs/:id — one run, for every repository and every
// viewer (`runView`, `studio/run.ts`). Readable exactly when the log is.
export async function runPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const reading = performance.now();
  const found = runLog(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "");
  notePhase(ctx.request, "log", performance.now() - reading);
  if (!found.ok) return notFoundPage(ctx);
  const { run, lines, truncated, logHidden } = found.value;
  const looking = performance.now();
  const looks = logHidden ? [] : readLooks(ctx.app.config.dataDir, run);
  notePhase(ctx.request, "looks", performance.now() - looking);
  const rendering = performance.now();
  const view = await runView(ctx, repo, run, lines, truncated, logHidden, looks);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return view;
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
      message: steerRefusedWords(steered.error),
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
