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
import { pullStatus, revertOf, type Pull } from "../../core/pulls.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import { checkSummary } from "../../core/runs.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, when } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  btn,
  card,
  confirmAction,
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
import {
  decisionActions,
  decisionForm,
  decisionsFor,
  type Decision,
} from "./asks.ts";
import { pullWord, servingHistory, wordBadge, type WordCtx } from "./words.ts";

/** What a conflicted change's own page says: the base it no longer merges
 * into, the first few files (bounded, so a huge conflict never floods the
 * page), and what fixes it. */
function conflictWords(baseBranch: string, files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? `, and ${files.length - 3} more` : "";
  return `it conflicts with ${baseBranch} in ${shown}${more} — bring the branch up to date and it can land`;
}

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
  // Dev's own address for this change, and the only one the page *posts*
  // to: ship, say and the escape to the diff all live under
  // `/pulls/:number`, whether a reader arrived there or at
  // `/changes/:number` (`changeHref`, nouns.ts).
  const thread = `${base}/pulls/${pull.number}`;
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
  };
  const { word, note: checkNote } = await pullWord(wordCtx, pull);
  // Whether this change still merges into its base is asked here, on its own
  // page, and nowhere a list of changes renders — a git call per open pull
  // would undo the home's own bound (`askCandidatesFor`). Only an open,
  // unmerged pull can conflict; a merged or closed one already has its word.
  const status =
    pull.mergedAt === null && pull.state !== "closed"
      ? await pullStatus(wordCtx.dir, pull)
      : undefined;
  const conflicted =
    status !== undefined && !status.mergeable && status.conflicts.length > 0;
  const note = conflicted
    ? conflictWords(pull.baseBranch, status.conflicts)
    : checkNote;
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
  const crewDecision = decisionsFor(ctx, [repo]).find(
    (d) => d.pull?.id === pull.id,
  );
  // A person's own change carries no crew decision (`decisionsFor` reads
  // agent pulls only — #208's territory), but the change's own page still
  // owes its writer the same route and the same words, whoever opened it.
  // Ready to offer means: nothing to fix first (or it does, and that fix is
  // the conflict wording below), and shipping would not be refused for want
  // of a green check under this repository's own setting (`requireChecks`,
  // the same flag `shipSubmit` reads).
  const writer = ctx.auth.user !== undefined && canWrite(db, repo, ctx.auth.user);
  const openForOwner = writer && status !== undefined;
  const ownReady =
    crewDecision === undefined &&
    openForOwner &&
    (conflicted || word === "look" || !repo.requireChecks);
  const own: Decision | undefined = ownReady
    ? {
        kind: "look",
        id: `own:${pull.id}`,
        repo,
        pull,
        who: pull.authorName,
        says:
          word === "look"
            ? "The check is green. Look at the preview, then ship it or say what is off."
            : "This app does not wait on the check to ship. Look at the preview, then ship it or say what is off.",
        short: word === "look" ? "the check is green" : "ready to ship",
      }
    : undefined;
  const decision = crewDecision ?? own;
  // Nothing to offer yet, and nothing wrong either — the check just has not
  // gone green, and this repository waits for that before it ships.
  const ownNotReadyNote =
    crewDecision === undefined && openForOwner && !conflicted && !ownReady
      ? note
      : undefined;

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

  // A conflicted change never offers Ship as though it would work — pressing
  // it would only be refused. The button that helps posts to the very same
  // route (`/ship`): `shipSubmit` already turns a conflict there into the
  // crew bringing the branch up to date, so nothing new is written, only said
  // sooner and in plain words. The same wording and the same button serve a
  // person's own change (`own`, above) exactly as they serve the crew's — one
  // card, one vocabulary, whoever opened the change.
  const decisionBody =
    decision !== undefined
      ? conflicted && decision.kind === "look" && decision.pull
        ? html`<p>${decision.who} finished "${decision.pull.title}", but ${conflictWords(
            pull.baseBranch,
            status!.conflicts,
          )}.</p>
            <div class="bar mt">
              <form method="post" action="${thread}/ship">
                ${btn("Bring up to date", { size: "sm", variant: "primary" })}
              </form>
            </div>`
        : html`<p>${decision.says}</p>
            <div class="bar mt">${decisionActions(ctx, decision)}</div>`
      : ownNotReadyNote !== undefined
        ? html`<p class="muted small">Not ready to ship — ${ownNotReadyNote}.</p>`
        : undefined;
  const decisionSection = when(decisionBody, (body) =>
    card(body, {
      head: html`${icon("alert")}
        <h2>Decide</h2>`,
    }),
  );

  // A shipped change offers one more verb: open a new change that undoes
  // exactly what it shipped, for someone to ship. Never on a change still
  // open (nothing shipped to take back yet), never on a mirror (the origin
  // owns that history), never twice. The action re-checks all of this and
  // does the git work; this only decides whether to offer the button.
  const takeBackSection = when(
    pull.mergedAt !== null &&
      writer &&
      repo.origin === null &&
      pull.originHeadRepo === null &&
      revertOf(db, repo.id, pull.id) === undefined,
    () =>
      card(
        html`<p class="muted small">
            Take it back — opens a new change that undoes exactly what this
            one shipped, for a person to ship.
          </p>
          <div class="bar mt">
            ${confirmAction({
              action: `${thread}/take-back`,
              verb: "Take it back",
              size: "sm",
            })}
          </div>`,
      ),
  );

  const talk = conversation(ctx, repo, pull, { openVerb: "opened this" });

  const body = html`${repoHeader(ctx, repo, "pulls", {
      compact: true,
      ownTitle: true,
    })}
    ${head} ${checkLine} ${decisionSection} ${takeBackSection}
    ${lookCard(ctx, repo, record, pull, pull.headOid)}
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          stateAction: `${thread}/state`,
          state: pull.state,
          locked: pull.mergedAt !== null,
          closeLabel: "Close change",
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
    palette: repoPalette(ctx, repo),
    body,
    scriptJs: liveClientJs,
  });
}
