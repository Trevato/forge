/**
 * One change in the studio: a pull is judged by what it does, not by its
 * diff — the title and the author's own words, the check and the preview in
 * the studio's five words, the look when one has been taken, the same
 * decision the asks panel would offer, and the conversation. No diff is
 * computed here, so the page never gets slower as a change gets bigger;
 * `?mode=dev` reads the code, unchanged (`pages/pull.ts`).
 */

import { appsRuntime } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import type { Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import { checkSummary } from "../../core/runs.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  card,
  icon,
  originTag,
  stateBadge,
  time,
  userLink,
} from "../ui.ts";
import { previewCard } from "../pages/apps.ts";
import { lookCard } from "../pages/looks.ts";
import { pullState } from "../pages/pulls.ts";
import { composer, conversation, originGlyph } from "../pages/thread.ts";
import { decisionActions, decisionForm, decisionsFor } from "./asks.ts";
import { studioCss } from "./style.ts";
import { pullWord, wordBadge, type WordCtx } from "./words.ts";

/**
 * GET /:owner/:name/pulls/:number in studio mode: a change is judged by
 * what it does, not by its diff. The title and the author's own words (the
 * opening post, same as dev), who made it and when, the check and the
 * preview in the studio's five words, the look when one has been taken, the
 * same decision the asks panel would offer, and the conversation — with the
 * diff exactly one click away at `?mode=dev`. No diff is computed here, so
 * this never gets slower as a change gets bigger.
 */
export async function studioPull(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  record: AppRecord,
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const thread = `${base}/pulls/${pull.number}`;
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
  };
  const { word, note } = await pullWord(wordCtx, pull);
  // Before a merge the deploy worth linking is the preview's own check;
  // after, it is production's — the preview's run may already be torn
  // down, and the word above is judged by production regardless.
  let deploy: { id: string; commitOid: string } | undefined;
  if (pull.mergedAt === null) {
    const run = checkSummary(db, pull.id, pull.headOid).run;
    if (run) deploy = { id: run.id, commitOid: run.commitOid };
  } else {
    const production = wordCtx.runtime
      ?.status(record)
      .find((e) => e.env === "production");
    if (production?.runId)
      deploy = { id: production.runId, commitOid: production.commitOid };
  }
  const decision = decisionsFor(ctx, [repo]).find(
    (d) => d.pull?.id === pull.id,
  );

  const head = html`<div class="issue-head">
    <h1>${pull.title} <span class="number">#${pull.number}</span></h1>
    <div class="issue-meta">
      ${stateBadge(pullState(pull))}
      <span
        >${pull.originAuthor
          ? originTag(pull.originAuthor, originGlyph(repo))
          : userLink(pull.authorName)}
        opened this ${time(pull.createdAt)}</span
      >
      ${when(
        pull.originUrl,
        (url) =>
          html`<a class="origin-link" href="${url}" rel="noreferrer noopener"
            >${icon("external")}view on origin</a
          >`,
      )}
    </div>
  </div>`;

  const checkLine = card(
    html`<p class="studio-pull-check">
      ${wordBadge(word)} <span class="muted small">${note}</span>
      ${when(
        deploy,
        (d) =>
          html`<span class="where-sep" aria-hidden="true">·</span
            ><a href="${base}/runs/${d.id}"
              >deploy ${d.commitOid.slice(0, 7)}</a
            >`,
      )}
    </p>`,
  );

  const decisionSection = when(decision, (d) =>
    card(
      html`<p>${d.says}</p>
        <div class="bar mt">${decisionActions(ctx, d)}</div>`,
      {
        head: html`${icon("alert")}
          <h2>Decide</h2>`,
      },
    ),
  );

  const talk = conversation(ctx, repo, pull, { openVerb: "opened this" });

  const body = html`${repoHeader(ctx, repo, "pulls", {
      compact: true,
      ownTitle: true,
    })}
    ${head} ${checkLine} ${decisionSection}
    ${lookCard(ctx, repo, record, pull, pull.headOid)}
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          stateAction: `${thread}/state`,
          state: pull.state,
          locked: pull.mergedAt !== null,
          kind: "pull",
        })}
      </div>
      <aside>${previewCard(ctx, repo, pull)}</aside>
    </div>
    <p class="muted small mt">
      <a href="${thread}?mode=dev">${icon("code")}Read the code</a> — every
      file it changed, line by line.
    </p>
    ${decision ? decisionForm(decision) : null}
    ${liveMount({
      repo: base,
      thread: "pull",
      number: pull.number,
      lastCommentId: talk.lastCommentId,
    })}`;

  return page({
    ctx,
    title: `${pull.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: studioCss,
    scriptJs: liveClientJs,
  });
}
