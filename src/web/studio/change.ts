/**
 * One change: the one page for a pull, on every repository and for every
 * viewer. A pull is judged by what it does, not by its diff — the title and
 * the author's own words, the check and the preview in the studio's five
 * words, the look when one has been taken, the same decision the asks panel
 * would offer, and the conversation with every verdict in it. The code is
 * one tab deeper, the Files step (`pullFilesPage`, `pages/pull.ts`); no
 * diff is computed here, so the page never gets slower as a change gets
 * bigger.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { cardPath } from "../og/path.ts";
import { pullProposalOf } from "../../core/proposal_token.ts";
import { getIssueById } from "../../core/issues.ts";
import { mayEditIssue } from "../../actions/issues.ts";
import { marksByName, type Mark } from "../../core/marks.ts";
import { waitingFor } from "../../core/waiting_for.ts";
import { mayView } from "../../core/sealed.ts";
import { threadNote } from "../../crew/direct.ts";
import { appsRuntime, envsFor } from "../../apps/runtime.ts";
import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import {
  getPull,
  pullStatus,
  revertOf,
  toldBy,
  variantSiblings,
  type Pull,
  pullDir,
} from "../../core/pulls.ts";
import { canAdmin, canWrite, type Repo } from "../../core/repos.ts";
import { listReviews, type Review } from "../../core/reviews.ts";
import { wallOf, wallPlain, wallSentence, type Wall } from "../../contract/policy.ts";
import { checkSummary } from "../../core/runs.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
} from "../chrome.ts";
import { html, raw, when, type Html } from "../html.ts";
import type { IconName as Glyph } from "../icons.ts";
import { threadLine } from "../describe.ts";
import { fragment, page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  btn,
  card,
  confirmAction,
  badge,
  icon,
  originTag,
  seg,
  time,
  tlEvent,
  userLink,
  verdictBadge,
  type Tone,
} from "../ui.ts";
import { previewCard } from "../pages/apps.ts";
import { lookCard } from "../pages/looks.ts";
import { approveHereCard, pullChecksLineFor, teamsCard } from "../pages/pull.ts";
import { guestWalls, strangerCard } from "../pages/pull-guest.ts";
import { combinedCard } from "../pages/pull-combined.ts";
import { teamVerdicts } from "../../core/issue_teams.ts";
import { liveRegionsJs } from "../client.ts";
import { pullState } from "../pages/pulls.ts";
import { workSpent } from "../pages/runs.ts";
import {
  composer,
  conversation,
  originGlyph,
  parseNumber,
  type Entry,
} from "../pages/thread.ts";
import { KIND_TIER, type Decision } from "./asks.ts";
import { decisionActions, decisionForm, decisionsFor } from "./decisions.ts";
import { tellLine, tellsAnswered } from "./branch_tell.ts";
import { previewVision } from "../../crew/vision.ts";
import { visionPreviewCard } from "./direction.ts";
import { holdCard } from "./hold.ts";
import { pullMayRun } from "../../core/pull_trust.ts";
import { nextOfPull } from "../../flow/next_actor.ts";
import { STEP_MEANS, STEPS, stepOfPull, stepWord, type PathStep } from "../../flow/path.ts";
import { changeHref } from "./nouns.ts";
import { pullWord, servingHistory, stateDot, wordDot, type WordCtx } from "./words.ts";
import { getHold } from "../../core/holds.ts";
import { pullRoster } from "./pull_roster.ts";

/** The pull and its repo, or the response that refuses to say why not. */
export function pullContext(ctx: Ctx): { repo: Repo; pull: Pull } | Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull || !mayView(ctx.app.db, repo, pull, ctx.auth.user))
    return notFoundPage(ctx);
  return { repo, pull };
}

/**
 * A pull that changes the policy: what it lets through that the base did
 * not. It is a wall — the crew never lands it on its own — so the card says
 * so, in the same sentences the ledger keeps, and leaves the decision to
 * the person reading.
 */
export function wallCard(wall: Wall, act?: string): Html {
  return card(
    html`<p class="muted small">
        ${wall.unsound !== undefined
          ? "An app built on it does not boot. A person decides this one."
          : "A cell loosened is a decision undone, so the crew leaves this to a person: read the cells, then land or say what is off."}
      </p>
      <div class="stack stack-tight mono">
        ${(wall.unsound ?? wall.loosened.map(wallSentence)).map(
          (line) => html`<div>${line}</div>`,
        )}
      </div>${when(
        act,
        (thread) => html`<p class="small">
            ${wall.unsound !== undefined
              ? "This one does not boot."
              : `If you allow it, ${wall.loosened.map(wallPlain).join("; ")}.`}
          </p>
          <div class="bar mt">
            <form method="post" action="${thread}/merge">
              <input type="hidden" name="strategy" value="squash" />
              ${btn("Allow it and merge", { variant: "primary", icon: "merge" })}
            </form>
            <form method="post" action="${thread}/review-state">
              <input type="hidden" name="state" value="changes_requested" />
              <label class="small"
                >Why (optional)
                <input name="body" autocomplete="off" />
              </label>
              ${btn("Send it back", { variant: "danger" })}
            </form>
          </div>`,
      )}`,
    {
      tone: "attn",
      extra: "wall mt",
      head: html`${icon("shield")}
        <strong
          >${wall.unsound !== undefined
            ? "This pull's contract does not read."
            : `This pull changes the policy: ${wall.loosened.length === 1 ? "one door opens" : `${wall.loosened.length} doors open`} wider.`}</strong
        >`,
    },
  );
}

// ---- verdicts, in the timeline ----

/**
 * One verdict as a timeline entry.
 *
 * Muted and marked when it was passed on an older head: it is history, not a
 * current position, and a dismissed approval that still looks like an
 * approval is exactly how a review gate becomes decorative.
 */
function reviewEntry(
  review: Review,
  headOid: string,
  glyph: Glyph,
  marks: ReadonlyMap<string, Mark>,
): Entry {
  const stale = review.commitOid !== headOid;
  const tone: Tone = stale
    ? "default"
    : review.state === "approved"
      ? "success"
      : review.state === "changes_requested"
        ? "danger"
        : "default";
  const who =
    review.originAuthor === null
      ? userLink(review.authorName, { mark: marks.get(review.authorName) })
      : originTag(review.originAuthor, glyph);
  return {
    at: review.createdAt,
    node: tlEvent({
      icon:
        review.state === "approved"
          ? "check"
          : review.state === "changes_requested"
            ? "alert"
            : "comment",
      tone,
      body: html`${who} ${verdictBadge(review.state, { stale })}
      ${time(review.createdAt)}${when(
        stale,
        () => html`<span class="muted">— before the latest push</span>`,
      )}${when(
        review.body !== "",
        () =>
          html`<div class="card">
            <div class="prose comment-body">
              ${renderMarkdown(review.body)}
            </div>
          </div>`,
      )}`,
    }),
  };
}

/** A change's head, the same on both of its tabs: the title, its state,
 * who opened it and in answer to whom, where it came from, and what the
 * crew spent on it. */
export function changeHead(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  live: { readonly headOid: string; readonly conflicts: number } | null = null,
): Html {
  const next = live === null ? null : nextOfPull(ctx.app.db, pull, live);
  const step =
    live === null && pull.mergedAt === null
      ? null
      : stepOfPull(ctx.app.db, repo, pull, live ?? { headOid: pull.headOid, conflicts: 0 }, next);
  const who = toldBy(ctx.app.db, pull);
  const marks = marksByName(ctx.app.db, [pull.authorName, who ?? ""]);
  return html`<div class="page-head">
    <h1>${pull.title} <span class="num">#${pull.number}</span></h1>
    <div class="page-head-sub bar muted small">
      ${stateDot(
        pullState(pull),
        getIssueById(ctx.app.db, pull.id)?.closeReason === "parked",
      )}
      <span
        >${pull.originAuthor
          ? originTag(pull.originAuthor, originGlyph(repo))
          : userLink(pull.authorName, { mark: marks.get(pull.authorName) })}
        opened this ${time(pull.createdAt)}</span
      >${when(
        who,
        (name) =>
          html`<span class="told-by"
            >in answer to ${userLink(name, { mark: marks.get(name) })}</span
          >`,
      )}
      ${when(
        pull.originUrl,
        (url) =>
          html`<a class="bar muted small" href="${url}" rel="noreferrer noopener"
            >${icon("external")}view on origin</a
          >`,
      )}
      ${workSpent(ctx, repo, pull.id)}${when(
        pullProposalOf(ctx.app.db, pull.id),
        (p) =>
          html`<span class="proposed-by"
            >proposed by child <span class="mono">${p.child}</span> from
            <span class="mono">${p.origin}</span></span
          >`,
      )}
    </div>
    ${when(step, (st) => pathLine(st, next === null ? undefined : `${next.who}, ${next.why}`))}
  </div>`;
}

/**
 * Where the pull is on the one path (#7703): the four words, the current one
 * marked, and why it waits there. The words link to /pipeline, which says
 * what each one means and holds the finer steps.
 */
export function pathLine(p: PathStep, next?: string): Html {
  const at = STEPS.indexOf(p.step);
  const words = STEPS.map((s, i) => {
    const label = stepWord(s);
    if (i === at)
      return html`<strong aria-current="step" title="${STEP_MEANS[s]}">${label}</strong>${p.done ? html` ${badge("done", { tone: "success" })}` : null}`;
    return html`<span>${label}</span>`;
  });
  return html`<p class="muted small" data-path="${p.step}">
    <a href="/pipeline">${words.map((w, i) => html`${i > 0 ? " · " : ""}${w}`)}</a>
    — ${p.why}${next === undefined ? "" : html`<span class="next-actor"> Next: ${next}.</span>`}
  </p>`;
}

/** The change's two steps: the change itself, and its Files one tab
 * deeper — never a mode, the same address family either way. */
export function changeTabs(
  repo: Repo,
  pull: Pull,
  current: "change" | "files",
): Html {
  const base = repoBase(repo);
  return html`<div class="bar mt mb">
    ${seg([
      {
        label: "Conversation",
        href: changeHref(base, pull.number),
        current: current === "change",
      },
      {
        label: "Files",
        href: `${base}/pulls/${pull.number}/files`,
        current: current === "files",
      },
    ])}
  </div>`;
}

/** What a conflicted change's own page says: the base it no longer merges
 * into, the first few files (bounded, so a huge conflict never floods the
 * page), and what fixes it. */
function conflictWords(baseBranch: string, files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? `, and ${files.length - 3} more` : "";
  return `it conflicts with ${baseBranch} in ${shown}${more} — bring the branch up to date and it can land`;
}

/**
 * GET /:owner/:name/pulls/:number, for every repository and every viewer. An older `?rc=` link (an inline comment form
 * on the diff) is handed on to the Files step, where the diff now lives.
 */
export async function pullPage(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  if (ctx.url.searchParams.has("rc"))
    return redirect(
      `${repoBase(repo)}/pulls/${pull.number}/files${ctx.url.search}`,
    );
  return await changeConversation(ctx, repo, pull);
}

/**
 * What a change's page says about where it stands, drawn once: the word and
 * its note, the deploy worth linking, and the Preview card. The page's first
 * paint and `pullStateFragment` both come through here, so the two can never
 * disagree. Bounded the way the page is: `pullWord` and one `pullStatus`, no
 * diff, no query per comment.
 */
async function pullPanels(ctx: Ctx, repo: Repo, pull: Pull, spent: Spent = newSpent()) {
  const record: AppRecord | undefined = getAppByRepo(ctx.app.db, repo.id);
  const db = ctx.app.db;
  const base = repoBase(repo);
  // The pull request's address, and the only one the page *posts* to:
  // ship, say and the escape to the diff all live under `/pulls/:number`.
  const thread = `${base}/pulls/${pull.number}`;
  const wordCtx: WordCtx = {
    db,
    // The change is read where its objects are (`pullDir`).
    dir: await pullDir(db, ctx.app.reposRoot, repo, pull),
    runtime: appsRuntime(ctx.app),
    record,
    history: servingHistory(),
    viewer: ctx.auth.user,
  };
  const { word, note: checkNote } = await lap(spent, "checks", () =>
    pullWord(wordCtx, pull),
  );
  // Whether this change still merges into its base is asked here, on its own
  // page, and nowhere a list of changes renders — a git call per open pull
  // would undo the home's own bound (`askCandidatesFor`). Only an open,
  // unmerged pull can conflict; a merged or closed one already has its word.
  // The review gate rides along, so the decision below never offers Ship on
  // a change `mergePull` would refuse for want of an approval.
  const status =
    pull.mergedAt === null && pull.state !== "closed"
      ? await lap(spent, "diff", () =>
          pullStatus(wordCtx.dir, pull, {
            db,
            requireReview: repo.requireReview,
          }),
        )
      : undefined;
  const conflicted =
    status !== undefined && !status.mergeable && status.conflicts.length > 0;
  // A reader's head runs nothing until a writer approves it (#777): say
  // that, rather than leave a word waiting on something that will not come.
  const waitingOnApproval =
    status !== undefined && !pullMayRun(db, repo, pull, status.headOid);
  const note = conflicted
    ? conflictWords(pull.baseBranch, status.conflicts)
    : waitingOnApproval
      ? "checks and the preview wait for a writer to approve this head"
      : checkNote;
  // Before a merge the deploy worth linking is the preview's own check;
  // after, it is production's — the preview's run may already be torn
  // down, and the word above is judged by production regardless.
  let deploy: { id: string; commitOid: string } | undefined;
  if (pull.mergedAt === null) {
    const run = (await lap(spent, "checks", async () =>
      checkSummary(db, pull.id, pull.headOid),
    )).run;
    if (run) deploy = { id: run.id, commitOid: run.commitOid };
  } else {
    const production =
      record === undefined
        ? undefined
        : envsFor(ctx.app, ctx.auth.user, record).find(
            (e) => e.env === "production",
          );
    if (production?.runId)
      deploy = { id: production.runId, commitOid: production.commitOid };
  }

  // At rest the check is a line, not a card: a dot, its word, the note.
  const checkLine = html`<p
    class="studio-pull-check"
    data-head="${pull.mergedOid ?? pull.headOid}"
  >
    ${wordDot(word)}
    <span class="word-text" data-pull-word>${word === "told" ? "open" : word}</span>
    <span class="muted small">${note}</span>
    ${when(
      tick(spent, "tells", () => tellsAnswered(db, repo.id, [pull]).get(pull.number)),
      (t) => html`<span class="sep" aria-hidden="true">·</span
        >${tellLine(base, t)}`,
    )}
    ${when(
      deploy,
      (d) =>
        html`<span class="sep" aria-hidden="true">·</span
          ><a href="${base}/runs/${d.id}">deploy ${d.commitOid.slice(0, 7)}</a>`,
    )}
  </p>`;

  const preview = tick(spent, "preview", () =>
    when(record, () => previewCard(ctx, repo, pull)),
  );
  return {
    record,
    db,
    base,
    thread,
    wordCtx,
    word,
    status,
    conflicted,
    note,
    checkLine,
    preview,
  };
}

/**
 * GET /:owner/:name/pulls/:number/state — the check line and the Preview
 * card, bare. The page's live client fetches it when the change merges, when
 * its preview deploys or production serves, and swaps the two in place.
 * Authorized as the page is: a viewer who cannot read it gets the same 404.
 */
export async function pullStateFragment(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return fragment(html``, { status: 404 });
  const { checkLine, preview } = await pullPanels(
    ctx,
    found.repo,
    found.pull,
  );
  return fragment(
    html`<div id="pull-check">${checkLine}</div>
      <div id="pull-preview">${preview}</div>`,
    { request: ctx.request },
  );
}

/**
 * A change is judged by what it does, not by its diff. The title and the
 * author's own words (the opening post), who made it and when, the check
 * and the preview in the studio's five words, the look when one has been
 * taken, the same decision the asks panel would offer, and the
 * conversation — with the diff one tab deeper, at Files.
 */
async function changeConversation(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
): Promise<Response> {
  const { request } = ctx;
  const began = performance.now();
  const spent = newSpent();
  notePhase(request, "session", takeSessionTime(request));
  const { record, db, base, thread, wordCtx, word, status, conflicted, note, checkLine, preview } =
    await pullPanels(ctx, repo, pull, spent);
  // The check's own line, live, with a running check's counts: the one the
  // Files step draws (`pullChecksLineFor`), for an open change.
  const runLine =
    status === undefined
      ? undefined
      : await lap(spent, "checks", () =>
          pullChecksLineFor(ctx, repo, pull, status, wordCtx.dir),
        );
  // A change that loosens the policy is a person's call: said here, above
  // the decision, as well as on the Files step beside the merge box.
  const wall =
    status === undefined
      ? undefined
      : await lap(spent, "diff", () =>
          wallOf(wordCtx.dir, status.baseOid, status.headOid),
        );
  // Everything the Decide card, the vision preview and Take it back read is
  // read here, under `decide`; only this pull's own asks (`pull`).
  const decideAt = performance.now();
  const crewDecision = decisionsFor(ctx, [repo], {
    evenDismissed: true,
    pull: pull.id,
  }).find((d) => d.pull?.id === pull.id);
  // A person's own change carries no crew decision (`decisionsFor` reads
  // agent pulls only — #208's territory), but the change's own page still
  // owes its writer the same route and the same words, whoever opened it.
  // Ready to offer means: nothing to fix first (or it does, and that fix is
  // the conflict wording below), and shipping would not be refused for want
  // of a green check under this repository's own setting (`requireChecks`,
  // the same flag `shipSubmit` reads).
  const writer = ctx.auth.user !== undefined && canWrite(db, repo, ctx.auth.user);
  const openForOwner = writer && status !== undefined;
  const reviewed = status?.reviews == null || status.reviews.mergeable;
  // A mirror's change lands on the origin, never here (`mergePull` refuses
  // it as "mirrored"): no decision is offered, and Files says where to merge.
  const mirrored = repo.origin !== null || pull.originHeadRepo !== null;
  const ownReady =
    crewDecision === undefined &&
    openForOwner &&
    reviewed &&
    !mirrored &&
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
            : record === undefined
              ? "Nothing here waits on a check to ship. Read it, then ship it or say what is off."
              : "This app does not wait on the check to ship. Look at the preview, then ship it or say what is off.",
        short: word === "look" ? "the check is green" : "ready to ship",
        consequence: KIND_TIER.look,
        waiting: waitingFor({
          kind: "look",
          conflicts: conflicted ? 1 : 0,
          assignedToViewer: pull.assigneeId === ctx.auth.user?.id,
          who: pull.authorName,
        }),
      }
    : undefined;
  // Whoever opened it, Ship is offered only where `mergePull` would take
  // it: a mirror offers no decision at all, and a review gate that is not
  // yet satisfied holds back only the one that ships — a crew change whose
  // check failed still offers Retry or Close, and its reason is the check.
  const candidate = crewDecision ?? own;
  const waitsOnReview = !reviewed && candidate?.kind === "look";
  const decision = mirrored || waitsOnReview ? undefined : candidate;
  // Nothing to offer yet, said plainly to a writer: the merge belongs to the
  // origin, the review gate is still closed, or the check has not gone green
  // and this repository waits for that before it ships.
  const ownNotReadyNote = !openForOwner
    ? undefined
    : mirrored
      ? "it merges on the origin, from its Files step"
      : !reviewed && (candidate === undefined || waitsOnReview)
        ? "it waits on an approving review of what it is now"
        : crewDecision === undefined && !conflicted && !ownReady
          ? note
          : undefined;

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
  const visionPreview =
    ctx.auth.user !== undefined && canAdmin(db, repo, ctx.auth.user)
      ? await previewVision(ctx.app, repo, pull)
      : null;
  const decisionForms = decision ? decisionForm(decision) : null;
  // No card, no heading: the decision is the page's one primary action.
  const decisionSection = when(
    decisionBody,
    (body) => html`<div class="mt mb" id="decide">${body}</div>`,
  );

  // A shipped change offers one more verb: open a new change that undoes
  // exactly what it shipped, for someone to ship. Never on a change still
  // open (nothing shipped to take back yet), never on a mirror (the origin
  // owns that history), never twice. The action re-checks all of this and
  // does the git work; this only decides whether to offer the button.
  const mayTakeBack =
    pull.mergedAt !== null &&
    writer &&
    repo.origin === null &&
    pull.originHeadRepo === null &&
    revertOf(db, repo.id, pull.id) === undefined;
  const takeBackSection = when(
    mayTakeBack,
    () =>
      html`<div class="bar mt" id="take-back">
        ${confirmAction({
          action: `${thread}/take-back`,
          verb: "Take it back",
          size: "sm",
        })}
        <span class="muted small"
          >opens a new change that undoes exactly what this one shipped</span
        >
      </div>`,
  );

  const siblings = variantSiblings(db, [pull])[0] ?? [];
  spent.decide += performance.now() - decideAt;
  const glyph = originGlyph(repo);
  const headOid = status?.headOid ?? pull.headOid;
  const pageHead = tick(spent, "head", () => ({
    top: html`${repoHeader(ctx, repo, "pulls", {
      compact: true,
      ownTitle: true,
      quiet: true,
    })}
    ${changeHead(ctx, repo, pull, status === undefined ? null : { headOid, conflicts: status.conflicts.length })}
    ${changeTabs(repo, pull, "change")}`,
    crumbs: crumbsFor(repo),
    palette: [
      ...repoPalette(ctx, repo),
      ...pullRoster({
        base,
        number: pull.number,
        headBranch: pull.headBranch,
        crossRepo: pull.crossRepo,
        signedIn: ctx.auth.user !== undefined,
        writer,
        state: pull.state === "closed" ? "closed" : "open",
        merged: pull.mergedAt !== null,
        labels: false,
        mayState: ctx.auth.user !== undefined && (ctx.auth.user.id === pull.authorId || writer),
        mergeReady: false,
        change: {
          shippable: decision !== undefined,
          conflicted: conflicted === true,
          mayEdit: mayEditIssue(ctx.app, repo, pull, ctx.auth.user).ok && !mirrored,
          takeBack: mayTakeBack,
        },
      }),
    ],
  }));
  const held = getHold(db, pull.id) !== undefined;
  const holdForm = held ? null : holdCard(ctx, repo, pull, { act: true, bare: true });
  // The rare actions, one step away: hold and take back.
  const more =
    holdForm === null && !mayTakeBack
      ? null
      : html`<details class="mt mb" id="more" ${ctx.url.searchParams.has("more") ? raw("open") : null}>
          <summary class="muted small">More: hold, take it back</summary>
          ${holdForm}${takeBackSection}
        </details>`;
  // A fork's pull combined with main on our side says so, with its note (#9012).
  const combined =
    status === undefined
      ? null
      : await lap(spent, "diff", () => combinedCard(wordCtx.dir, pull, headOid, status.baseOid));
  const walls = status === undefined ? [] : await guestWalls(ctx, repo, pull, status.baseOid);
  const next = await strangerCard(ctx, repo, pull, `${thread}/approve-guest`, walls);
  const gate = tick(
    spent,
    "gate",
    () => html`${held ? holdCard(ctx, repo, pull, { act: true }) : null}
    ${combined}
    ${next}
    ${approveHereCard(ctx, repo, pull, headOid, `${thread}/approve-here`)}
    ${teamsCard(teamVerdicts(db, { ...pull, headOid }))}
    ${when(wall, (w) => wallCard(w, writer ? thread : undefined))}`,
  );
  const look = tick(spent, "looks", () =>
    when(record, (r) => lookCard(ctx, repo, r, pull, pull.headOid)),
  );
  const reviewsAt = performance.now();
  const reviews = listReviews(db, pull.id);
  const reviewerMarks = marksByName(
    db,
    reviews.map((r) => r.authorName),
  );
  const talk = conversation(ctx, repo, pull, {
    openVerb: "opened this",
    extra: reviews.map((review) =>
      reviewEntry(review, headOid, glyph, reviewerMarks),
    ),
    editAction:
      mayEditIssue(ctx.app, repo, pull, ctx.auth.user).ok && !mirrored
        ? `${thread}/edit`
        : undefined,
  });
  const reply = composer(ctx, {
    action: `${thread}/comments`,
    // Closing is its author's or a writer's (`setIssueState`): nobody
    // else is shown a button the server would only refuse.
    ...(ctx.auth.user !== undefined &&
    (ctx.auth.user.id === pull.authorId || writer)
      ? { stateAction: `${thread}/state` }
      : {}),
    state: pull.state,
    locked: pull.mergedAt !== null,
    closeLabel: "Close pull request",
    plainSend: decision !== undefined,
    crewNote: threadNote(ctx.app.db, repo, pull),
  });
  spent.reviews += performance.now() - reviewsAt;

  // From here on nothing is read: `render` only builds the page.
  const body = html`${pageHead.top}
    ${when(siblings.length > 0, () =>
      html`<p class="muted small variant-link">
        <a href="${base}/variants/${pull.variantGroup ?? ""}"
          >Choose among ${siblings.length + 1} variants</a
        >
      </p>`,
    )}
    <div id="pull-check">${checkLine}</div>
    ${when(runLine, (l) => l)} ${gate} ${decisionSection}
    ${when(visionPreview, (v) => visionPreviewCard(v))}
    ${look}
    <div class="split">
      <div>
        ${talk.node}
        ${reply}
        ${more}
      </div>
      <aside><div id="pull-preview">${preview}</div></aside>
    </div>
    ${decisionForms}
    ${liveMount({
      repo: base,
      thread: "pull",
      number: pull.number,
      lastCommentId: talk.lastCommentId,
      head: pull.mergedOid ?? pull.headOid,
    })}`;

  const response = page({
    ctx,
    title: `${pull.title} · ${repo.name}`,
    ogImage: cardPath("pull", repo, pull),
    description: threadLine({
      private: repo.visibility === "private",
      word,
      title: pull.title,
      body: pull.body,
    }),
    crumbs: pageHead.crumbs,
    palette: pageHead.palette,
    body,
    scriptJs: `${liveClientJs}\n${liveRegionsJs}`,
  });
  // Each phase is named once, from what the laps added up to; render is what
  // is left of the page's own time, so the phases never exceed `app`.
  let read = 0;
  for (const [name, ms] of Object.entries(spent)) {
    notePhase(request, name, ms);
    read += ms;
  }
  notePhase(request, "render", Math.max(0, performance.now() - began - read));
  return response;
}

/** Milliseconds a change's page spent in each of its named phases. */
interface Spent {
  diff: number;
  checks: number;
  tells: number;
  preview: number;
  head: number;
  gate: number;
  decide: number;
  looks: number;
  reviews: number;
}
/** In the order Server-Timing names them. */
const newSpent = (): Spent => ({
  diff: 0,
  checks: 0,
  tells: 0,
  preview: 0,
  head: 0,
  gate: 0,
  decide: 0,
  looks: 0,
  reviews: 0,
});

/** Run `work` and add the time it took to `spent[key]`. */
async function lap<T>(spent: Spent, key: keyof Spent, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    spent[key] += performance.now() - started;
  }
}

/** The same for a synchronous read: no await, no microtask. */
function tick<T>(spent: Spent, key: keyof Spent, work: () => T): T {
  const started = performance.now();
  try {
    return work();
  } finally {
    spent[key] += performance.now() - started;
  }
}
