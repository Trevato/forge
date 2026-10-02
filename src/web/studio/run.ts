/**
 * One run in the studio: the transcript a person sits on while waiting for a
 * change to become visible — who is on it, the tell it came from, what it
 * has cost, its own lines as they land — and the one control a live run has,
 * Stop, which the home and the app page put on a row of their own. Steer and
 * Stop post to the very same routes with the very same checks as `runPage`
 * (`pages/runs.ts`); `?mode=dev` reads the same log there, unchanged.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { getIssueById } from "../../core/issues.ts";
import { getPull, openPullsClosing } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { isTerminal, type Run } from "../../core/runs.ts";
import { getUserById } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  repoBase,
  repoHeader,
  repoPalette,
} from "../chrome.ts";
import { studioRunJs } from "../client.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, icon } from "../ui.ts";
import { previewCard } from "../pages/apps.ts";
import { costText, durationText, runTitle } from "../pages/runs.ts";
import { sandboxLine } from "./sandbox.ts";
import { logBox, runVoice, RUN_TRANSCRIPT_CAP } from "./log.ts";
import { changeHref, tellHref } from "./nouns.ts";
import { unnamedRun, voiceFor, type Actor } from "./voice.ts";
import { runWord, servingHistory, wordBadge, type WordCtx } from "./words.ts";

/**
 * The one control a live run has: a person who can write here stops a
 * running one or takes a queued one back off the board. Nothing for runs
 * that are over, or for readers.
 */
export function stopForm(ctx: Ctx, repo: Repo, run: Run): Html | null {
  if (run.state !== "running" && run.state !== "queued") return null;
  if (run.kind !== "agent") return null;
  if (!canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user)) return null;
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


/**
 * GET /:owner/:name/runs/:id in the studio: who is on it, the tell it came
 * from, how long it has gone and what it has cost, the transcript itself,
 * and its state in the studio's own word — the page someone sits on while
 * waiting for a change to become visible. Steer and Stop are the very same
 * forms `runPage` offers, posting to the very same routes with the very
 * same checks; `?mode=dev` reads the transcript there, unchanged.
 */
export async function studioRun(
  ctx: Ctx,
  repo: Repo,
  run: Run,
  lines: readonly string[],
  truncated: boolean,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const writer = canSeeOwnerFacts(db, repo, ctx.auth.user);
  const actor =
    run.actorId === null ? undefined : getUserById(db, run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(db, run.issueId);
  // A deploy or a check speaks for itself (`runVoice`, shared with the tail
  // `studio/previews.ts` opens for the same lines while production comes
  // up); anything else is named by the one rule for it — `voiceFor`
  // (`studio/voice.ts`) says who is named and why. The title and the
  // transcript take the same name, so the page never carries two. The
  // steer box below is writer-only already, so it only ever renders with
  // the real name.
  const by: Actor = {
    name: actor?.username,
    isAgent: actor?.kind === "agent",
  };
  const who = runVoice(run.kind, writer, by);
  const title = runTitle(run, voiceFor(by, writer, unnamedRun(writer)), issue);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record: getAppByRepo(db, repo.id),
    history: servingHistory(),
  };
  const { word } = await runWord(wordCtx, run);
  const unfinished = !isTerminal(run.state);
  const duration = durationText(run);
  const stream = `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/log?follow=1`;

  // The pull this run's tell has become, once one exists: the tell itself
  // when the run is already a pull's own (feedback, a failed check, a
  // conflict fix), or the open pull that closes it while the run is still
  // the tell's first build — the case this page matters most for.
  const pull =
    issue === undefined
      ? undefined
      : issue.kind === "pull"
        ? getPull(db, repo.id, issue.number)
        : openPullsClosing(db, repo.id).get(issue.number);

  const head = html`<div class="issue-head">
    <h1>${title}</h1>
    <div class="issue-meta">
      ${wordBadge(word, "run-word")}
      ${when(
        issue,
        (i) =>
          html`<a
            href="${i.kind === "pull"
              ? changeHref(base, i.number)
              : tellHref(base, i.number)}"
            >#${i.number} ${i.title}</a
          >`,
      )}
      ${when(
        writer,
        () =>
          html`<span
              class="num"
              id="run-cost"
              ${run.costUsd > 0 ? null : html`hidden`}
              >${costText(run.costUsd)} spent</span
            >
            <span
              class="num"
              id="run-turns"
              ${run.turns > 0 ? null : html`hidden`}
              >${run.turns} turn${run.turns === 1 ? "" : "s"}</span
            >`,
      )}
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
    <p class="run-summary" id="run-summary">${run.summary}</p>
    ${sandboxLine(run)}
  </div>`;

  const body = html`${repoHeader(ctx, repo, "app", {
      compact: true,
      ownTitle: true,
    })}
    ${head}
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
    ${when(pull, (p) => previewCard(ctx, repo, p))}
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
      ${logBox({
        id: "run-log",
        who,
        cap: RUN_TRANSCRIPT_CAP,
        lines,
        ...(unfinished ? { stream } : {}),
        pulse: run.state === "running",
        extra: html`<button type="button" class="run-jump" id="run-jump" hidden>
          newer below
        </button>`,
      })}
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
    </div>
    <p class="muted small mt">
      <a href="${base}/runs/${run.id}?mode=dev">${icon("code")}Read the transcript</a>
      — every tool call, in dev's own words.
    </p>`;

  return page({
    ctx,
    title: `${title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: studioRunJs,
    // The no-script half of a live log: while the run is going, the page
    // refreshes itself; the script above removes this the moment it runs.
    ...(unfinished ? { refresh: { seconds: 5 } } : {}),
  });
}
