/**
 * The crew's answers, under the tell box: one row per tell the viewer said
 * on this app, newest first — the tell in their words, and what the crew
 * said back (its last comment on it, else its last finished run's summary,
 * else that it is working or waiting). One live region (`#live-answers`)
 * with an address of its own (`GET /:owner/:name/app/answers`), so an
 * answer that lands appears without a reload. Everything shown is the
 * viewer's own tell on an app they own; every string is escaped by `html`.
 */

import type { Database } from "bun:sqlite";
import { CREW_WORKING } from "../../actions/ask_state_words.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { listComments, listIssues, type Issue } from "../../core/issues.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { listRuns } from "../../core/runs.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { fragment, missingFragment } from "../layout.ts";
import { time } from "../ui.ts";
import { tellHref } from "./nouns.ts";

/** The events that can change an answer. */
export const ANSWERS_LIVE = "run.queued,run.started,run.finished,issue.*";

/** How many tells the region shows, and the longest answer it quotes. */
const SHOWN = 8;
const ANSWER_MAX = 600;

export interface Answer {
  readonly issue: Issue;
  /** Who answered and what they said; undefined while nobody has. */
  readonly said: { readonly who: string; readonly text: string; readonly at: string } | undefined;
  readonly working: boolean;
}

/** The viewer's own tells on `repo`, newest first, each with the crew's answer. */
export function answersFor(db: Database, repo: Repo, user: User): readonly Answer[] {
  const issues = listIssues(db, repo.id, {
    state: "all",
    author: user.username,
    limit: SHOWN,
  }).filter((i) => i.id !== repo.directionIssueId);
  return issues.map((issue) => {
    const comments = listComments(db, issue.id, { kind: "comment" });
    const speakers = getUsersByIds(db, [...new Set(comments.map((c) => c.authorId))]);
    const crewComment = comments
      .filter((c) => speakers.get(c.authorId)?.kind === "agent")
      .at(-1);
    const runs = listRuns(db, repo.id, { kind: "agent", issueId: issue.id, limit: 5 });
    const working = runs.some((r) => r.state === "queued" || r.state === "running");
    const finished = runs.find(
      (r) => (r.state === "ok" || r.state === "failed") && r.summary !== "",
    );
    const actors = finished?.actorId
      ? getUsersByIds(db, [finished.actorId]).get(finished.actorId)
      : undefined;
    const said = crewComment
      ? { who: crewComment.authorName, text: crewComment.body, at: crewComment.createdAt }
      : finished
        ? {
            who: actors?.username ?? "crew",
            text: finished.summary,
            at: finished.finishedAt ?? finished.createdAt,
          }
        : undefined;
    return { issue, said, working };
  });
}

/** Whether `user` may read the answers on `repo`: its owner, on an app. Both doors ask this. */
export function canSeeAnswers(db: Database, repo: Repo, user: User | undefined): user is User {
  return user !== undefined && getAppByRepo(db, repo.id) !== undefined && canSeeOwnerFacts(db, repo, user);
}

/** The region itself; empty (but present, so it can fill) with no tells yet. */
export function answersRegion(
  ctx: Ctx,
  repo: Repo,
  user: User,
  answers: readonly Answer[] = answersFor(ctx.app.db, repo, user),
): Html {
  const base = repoBase(repo);
  const rows = answers.map(({ issue, said, working }) => {
    const text =
      said === undefined
        ? null
        : said.text.length > ANSWER_MAX
          ? `${said.text.slice(0, ANSWER_MAX - 1).trimEnd()}…`
          : said.text;
    return html`<li class="answer" data-tell="${issue.number}">
      <a href="${tellHref(base, issue.number)}" class="answer-tell">${issue.title}</a>
      ${said === undefined
        ? html`<p class="muted small answer-wait">${working ? CREW_WORKING : "Waiting for the crew."}</p>`
        : html`<p class="answer-said"><b>${said.who}</b> ${time(said.at)}<br />${text}</p>`}
    </li>`;
  });
  return html`<div
    id="live-answers"
    data-live="${ANSWERS_LIVE}"
    data-live-repo="${repo.ownerName}/${repo.name}"
    data-live-src="${base}/app/answers"
  >
    ${rows.length === 0
      ? null
      : html`<section class="settings-block">
          <h2>The crew's answers</h2>
          <ul class="list answers">${rows}</ul>
        </section>`}
  </div>`;
}

// GET /:owner/:name/app/answers — the region alone, for the page that shows it.
export function appAnswersFragment(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  const user = ctx.auth.user;
  if (!repo || !timePhase(ctx.request, "access", () => canSeeAnswers(ctx.app.db, repo, user)))
    return missingFragment(ctx.request);
  const answers = timePhase(ctx.request, "answers", () => answersFor(ctx.app.db, repo, user!));
  const rendering = performance.now();
  const region = answersRegion(ctx, repo, user!, answers);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return fragment(region, { request: ctx.request });
}
