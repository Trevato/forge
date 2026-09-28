/**
 * One pull request: the conversation, the merge box, the commits it carries,
 * and the diff with inline review. This is the highest-value screen in the
 * product, so the merge box is an explicit state machine — one card variant
 * per state, each saying what is true and what you can do about it — and the
 * diff is given the full width it needs.
 */

import { addCommentThrough } from "../../actions/issues.ts";
import type { AccessError } from "../../actions/access.ts";
import {
  addReview,
  mergePull,
  pullThreads,
  resolveReviewThread,
  submitReview,
} from "../../actions/pulls.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { labelsFor, listLabels } from "../../core/issues.ts";
import {
  pullDiff,
  type MergePullError,
  type Pull,
  type PullReviewStatus,
  type PullStatus,
} from "../../core/pulls.ts";
import { getPull } from "../../core/pulls.ts";
import { checkSummary, type CheckSummary } from "../../core/runs.ts";
import {
  anchorKey,
  byAnchor,
  isReviewState,
  latestReviewByAuthor,
  listReviewComments,
  listReviews,
  type Review,
  type ReviewState,
  type Side,
} from "../../core/reviews.ts";
import { getUsersByIds } from "../../core/users.ts";
import { canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { commitLog } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import { wallOf, wallSentence, type Wall } from "../../contract/policy.ts";
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
import { diffSyntax } from "../diff-syntax.ts";
import {
  renderDiff,
  type DiffViewOptions,
  type ThreadView,
} from "../diff-view.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { renderMarkdown } from "../markdown.ts";
import type { IconName as Glyph } from "../icons.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  badge,
  btn,
  card,
  icon,
  labelCss,
  listCard,
  originTag,
  queuedPhrase,
  sha,
  stateBadge,
  time,
  tlEvent,
  userLink,
  verdictBadge,
  type Tone,
} from "../ui.ts";
import {
  assigneeCard,
  composer,
  conversation,
  labelsCard,
  originError,
  originGlyph,
  parseNumber,
  threadFragment,
  type Entry,
} from "./thread.ts";
import { previewCard } from "./apps.ts";
import { lookCard } from "./looks.ts";
import { pullState } from "./pulls.ts";
import { crewActivityCard } from "./runs.ts";
import { studioPull } from "../studio/change.ts";
import { studioRecord } from "../studio/nouns.ts";

/** The pull and its repo, or the response that refuses to say why not. */
function pullContext(ctx: Ctx): { repo: Repo; pull: Pull } | Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return notFoundPage(ctx);
  return { repo, pull };
}

/** Parse a "path~side~line" review anchor from a link or form field. */
function parseAnchor(
  raw: string | null,
): { path: string; side: Side; line: number } | undefined {
  if (!raw) return undefined;
  const at = raw.lastIndexOf("~");
  const at2 = raw.lastIndexOf("~", at - 1);
  if (at === -1 || at2 === -1) return undefined;
  const path = raw.slice(0, at2);
  const side = raw.slice(at2 + 1, at);
  const line = Number(raw.slice(at + 1));
  if ((side !== "old" && side !== "new") || !Number.isInteger(line) || line < 1)
    return undefined;
  return { path, side, line };
}

// ---- where the review stands ----

/** A reviewer's current verdict, keyed the way `latestReviewByAuthor` keys it. */
interface Standing {
  readonly who: string;
  readonly state: ReviewState;
  readonly stale: boolean;
}

/**
 * Where each reviewer stands right now, in the order they last spoke.
 *
 * `reviewSummary` counts this; the merge box has to *name* it — "changes
 * requested by bob" is a person to go and talk to, and "1 change requested"
 * is a number to stare at.
 */
function standings(
  db: Ctx["app"]["db"],
  pull: Pull,
  headOid: string,
): Standing[] {
  return [...latestReviewByAuthor(db, pull.id).values()].map((review) => ({
    who: review.originAuthor ?? review.authorName,
    state: review.state,
    stale: review.commitOid !== headOid,
  }));
}

/**
 * The reviews chip: the state of play in one line.
 *
 * Rendered whenever anybody has reviewed or the repository demands one —
 * otherwise the merge box stays the four-line card it was, because a repo
 * with no review policy should not grow review furniture.
 */
function reviewsChip(
  reviews: PullReviewStatus | null,
  by: readonly Standing[],
): Html {
  if (reviews === null) return html``;
  const blocking = by.filter(
    (s) => !s.stale && s.state === "changes_requested",
  );
  const parts: Html[] = [];
  if (reviews.approved > 0)
    parts.push(
      html`<span class="ok"
        >${icon("check")}${reviews.approved}
        approval${reviews.approved === 1 ? "" : "s"}</span
      >`,
    );
  if (blocking.length > 0)
    parts.push(
      html`<span class="bad"
        >${icon("alert")}changes requested by
        ${blocking.map((s) => s.who).join(", ")}</span
      >`,
    );
  if (parts.length === 0) {
    if (!reviews.required) return html``;
    parts.push(html`<span class="muted">No reviews yet</span>`);
  }
  return html`<p class="reviews-chip">
    ${parts.map((part, i) =>
      i === 0
        ? part
        : html`<span class="where-sep" aria-hidden="true">·</span>${part}`,
    )}${when(
      reviews.required,
      () =>
        html`<span class="where-sep" aria-hidden="true">·</span
          ><span class="muted">an approval is required</span>`,
    )}
  </p>`;
}

// ---- the checks ----

/**
 * The checks line: where the deploy of this head stands (docs/APPS.md, rule
 * 4). Rendered whenever the repository runs as an app or requires checks —
 * a repository with neither has no checks, and should not grow furniture
 * for them. A run is named so the reader can go and look at its log.
 */
function checksLine(
  base: string,
  check: CheckSummary,
  required: boolean,
  isApp: boolean,
): Html {
  if (!isApp && !required && check.state === "none") return html``;
  const run = check.run;
  const link =
    run === null
      ? null
      : html`<span class="where-sep" aria-hidden="true">·</span
          ><a href="${base}/runs/${run.id}"
            >deploy ${run.commitOid.slice(0, 7)}</a
          >`;
  const body =
    check.state === "ok"
      ? html`<span class="ok">${icon("check")}Checks passed</span>${link}`
      : check.state === "failed"
        ? html`<span class="bad">${icon("x")}Checks failed</span>${link}`
        : check.state === "queued"
          ? html`<span class="now"
              >${icon("loader")}Checks
              ${run ? queuedPhrase(run.createdAt) : "queued"}</span
            >${link}`
          : check.state === "running"
            ? html`<span class="now">${icon("loader")}Checks running</span
                >${link}`
            : check.state === "cancelled"
              ? html`<span>${icon("ban")}Checks cancelled</span>${link}`
              : html`<span>${icon("clock")}No checks on this head yet</span>`;
  return html`<p class="checks-line">
    ${body}${when(
      required,
      () =>
        html`<span class="where-sep" aria-hidden="true">·</span
          ><span>a passing deploy is required</span>`,
    )}
  </p>`;
}

// ---- the merge box ----

/**
 * Six states, six cards. Every one names the situation, gives the reason,
 * and offers exactly the actions that are actually available.
 */
/**
 * A pull that changes the policy: what it lets through that the base did
 * not. It is a wall — the crew never lands it on its own — so the card says
 * so, in the same sentences the ledger keeps, and leaves the decision to
 * the person reading.
 */
function wallCard(wall: Wall): Html {
  return card(
    html`${icon("shield")}
      <div class="grow">
        <div class="merge-headline">
          ${wall.unsound !== undefined
            ? "This pull's contract does not read."
            : `This pull changes the policy: ${wall.loosened.length === 1 ? "one door opens" : `${wall.loosened.length} doors open`} wider.`}
        </div>
        <p class="merge-sub">
          ${wall.unsound !== undefined
            ? "An app built on it does not boot. A person decides this one."
            : "A cell loosened is a decision undone, so the crew leaves this to a person: read the cells, then land or say what is off."}
        </p>
        <ul class="wall-cells">
          ${(wall.unsound ?? wall.loosened.map(wallSentence)).map(
            (line) => html`<li>${line}</li>`,
          )}
        </ul>
      </div>`,
    { tone: "attn", extra: "merge-box wall" },
  );
}

function mergeBox(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  status: PullStatus,
  mayMerge: boolean,
  by: readonly Standing[],
  check: CheckSummary,
  isApp: boolean,
): Html {
  const thread = `${repoBase(repo)}/pulls/${pull.number}`;
  const checks = checksLine(repoBase(repo), check, repo.requireChecks, isApp);
  const reopen = html`<form method="post" action="${thread}/state">
    <input type="hidden" name="state" value="open" />
    ${btn("Reopen", { size: "sm", icon: "pull" })}
  </form>`;

  if (pull.mergedAt !== null) {
    return card(
      html`${icon("merge")}
        <div class="grow">
          <div class="merge-headline">Merged.</div>
          <p class="merge-sub">
            <span class="mono">${pull.headBranch}</span> was merged into
            <span class="mono">${pull.baseBranch}</span>${when(
              pull.mergedOid,
              (oid) => html` as ${sha(oid, `${repoBase(repo)}/commit/${oid}`)}`,
            )}.
          </p>
        </div>`,
      { tone: "merged", extra: "merge-box" },
    );
  }

  if (pull.state === "closed") {
    return card(
      html`${icon("x")}
        <div class="grow">
          <div class="merge-headline">Closed without merging.</div>
          <p class="merge-sub">
            Nothing was applied to
            <span class="mono">${pull.baseBranch}</span>.
          </p>
        </div>
        ${when(
          ctx.auth.user !== undefined,
          () => html`<span class="merge-form">${reopen}</span>`,
        )}`,
      { extra: "merge-box" },
    );
  }

  // A mirror's merge belongs to the origin: merging locally would rewrite the
  // base branch here and be overwritten by the next fetch, and merging through
  // the API would have to reproduce the origin's strategy, protections and
  // required checks exactly. So the box says where the button is instead.
  if (repo.origin !== null || pull.originHeadRepo !== null) {
    const at = repo.origin;
    return card(
      html`${icon(at?.kind ?? "globe")}
        <div class="grow">
          <div class="merge-headline">Merge on the origin.</div>
          <p class="merge-sub">
            This repository mirrors
            ${at === null || at.fullName === ""
              ? html`another forge`
              : html`<span class="mono">${at.fullName}</span>`},
            which is truth for it. Merge there and the next sync brings back the
            merge commit it actually made.
          </p>
        </div>
        ${when(
          pull.originUrl,
          (url) =>
            html`<span class="merge-form"
              >${btn("Open on the origin", {
                href: url,
                variant: "primary",
                icon: "external",
              })}</span
            >`,
        )}`,
      { tone: "attn", extra: "merge-box" },
    );
  }

  if (!status.mergeable) {
    const reason =
      status.ahead === 0
        ? html`Base already contains these commits — there is nothing left to
          apply.`
        : status.conflicts.length > 0
          ? html`Conflicts in ${status.conflicts.length}
              file${status.conflicts.length === 1 ? "" : "s"}:
              <span class="mono"
                >${status.conflicts.slice(0, 3).join(", ")}</span
              >${status.conflicts.length > 3 ? "…" : ""}. Merge
              <span class="mono">${pull.baseBranch}</span> into the branch and
              push again.`
          : html`This branch cannot be applied automatically.`;
    return card(
      html`${icon("alert")}
        <div class="grow">
          <div class="merge-headline">Can't merge.</div>
          <p class="merge-sub">${reason}</p>
          ${reviewsChip(status.reviews, by)} ${checks}
        </div>`,
      { tone: "danger", extra: "merge-box" },
    );
  }

  // Git says yes; the review gate may still say no. It is the same question
  // `mergePull` asks at the moment it lands (`review_required`) — asked here
  // so the button is honest, not so the check happens here.
  const gated = status.reviews !== null && !status.reviews.mergeable;
  if (gated) {
    const blocking = by.filter(
      (s) => !s.stale && s.state === "changes_requested",
    );
    const why =
      blocking.length > 0
        ? html`${blocking.map((s) => s.who).join(", ")} asked for changes. Push
          a fix, and ask for another look.`
        : html`This repository requires an approving review of the commit that
          is head right now. A verdict passed before the latest push does not
          count.`;
    return card(
      html`${icon("eye")}
        <div class="grow">
          <div class="merge-headline">Waiting on review.</div>
          <p class="merge-sub">${why}</p>
          ${reviewsChip(status.reviews, by)} ${checks}
        </div>
        ${when(
          mayMerge,
          () =>
            html`<span class="merge-form"
              >${btn("Merge pull request", {
                variant: "primary",
                icon: "merge",
                disabled: true,
                title: "An approving review of this head is required first",
              })}</span
            >`,
        )}`,
      { tone: "attn", extra: "merge-box" },
    );
  }

  // The check gate, `mergePull`'s `checks_required`: the deploy of the
  // commit that is head right now must have passed. Read live here so the
  // button is honest — the refusal itself happens in the merge.
  if (repo.requireChecks && check.state !== "ok") {
    const why =
      check.state === "failed"
        ? html`The deploy of this head failed. Push a fix — a passing deploy is
          required before merging.`
        : check.state === "running" || check.state === "queued"
          ? html`This head is still deploying. The merge unlocks when the check
            passes.`
          : check.state === "cancelled"
            ? html`The deploy of this head was cancelled. Redeploy the preview,
              or push again.`
            : html`There is no deploy of this head yet. Nothing merges until one
              passes.`;
    return card(
      html`${icon("loader")}
        <div class="grow">
          <div class="merge-headline">Waiting on checks.</div>
          <p class="merge-sub">${why}</p>
          ${reviewsChip(status.reviews, by)} ${checks}
        </div>
        ${when(
          mayMerge,
          () =>
            html`<span class="merge-form"
              >${btn("Merge pull request", {
                variant: "primary",
                icon: "merge",
                disabled: true,
                title: "A passing deploy of this head is required first",
              })}</span
            >`,
        )}`,
      { tone: "attn", extra: "merge-box" },
    );
  }

  return card(
    html`${icon("check")}
      <div class="grow">
        <div class="merge-headline">
          Ready to merge — no conflicts with
          <span class="mono">${pull.baseBranch}</span>.
        </div>
        <p class="merge-sub">
          ${status.ahead} commit${status.ahead === 1 ? "" : "s"} will land on
          <span class="mono">${pull.baseBranch}</span>.
        </p>
        ${reviewsChip(status.reviews, by)} ${checks}
      </div>
      ${mayMerge
        ? html`<span class="merge-form">
            <form method="post" action="${thread}/merge" class="merge-form">
              <label class="sr-only" for="strategy">Merge strategy</label>
              <select class="input" id="strategy" name="strategy">
                <option value="merge">Merge commit</option>
                <option value="squash">Squash and merge</option>
              </select>
              ${btn("Merge pull request", {
                variant: "primary",
                icon: "merge",
              })}
            </form>
          </span>`
        : html`<span class="muted small"
            >You need write access to merge.</span
          >`}`,
    { tone: "success", extra: "merge-box" },
  );
}

// ---- threads ----

/**
 * Every thread's settled-ness, keyed the way the diff viewer looks it up.
 *
 * Who may settle one is the same rule `resolveReviewThread` enforces: a
 * writer, or anybody who commented in the thread — the reviewer who raised a
 * point is exactly the person who can say it is answered. Resolvers are
 * named in one grouped read rather than one per thread.
 */
function threadStateViews(
  ctx: Ctx,
  repo: Repo,
  threads: ReturnType<typeof pullThreads>,
): Map<string, ThreadView> {
  const user = ctx.auth.user;
  const writer = canWrite(ctx.app.db, repo, user);
  const resolvers = getUsersByIds(
    ctx.app.db,
    threads.map((t) => t.resolvedBy ?? "").filter(Boolean),
  );
  const views = new Map<string, ThreadView>();
  for (const t of threads) {
    const mine =
      user !== undefined &&
      t.comments.some((c) => c.authorName === user.username);
    views.set(anchorKey(t.path, t.side, t.line), {
      anchor: t.anchor,
      resolvedAt: t.resolvedAt,
      resolvedBy:
        t.resolvedBy === null
          ? null
          : (resolvers.get(t.resolvedBy)?.username ?? null),
      mayResolve: user !== undefined && (writer || mine),
    });
  }
  return views;
}

// ---- verdicts, in the timeline ----

/**
 * One verdict as a timeline entry.
 *
 * Muted and marked when it was passed on an older head: it is history, not a
 * current position, and a dismissed approval that still looks like an
 * approval is exactly how a review gate becomes decorative.
 */
function reviewEntry(review: Review, headOid: string, glyph: Glyph): Entry {
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
      ? userLink(review.authorName)
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
          html`<div class="prose review-body">
            ${renderMarkdown(review.body)}
          </div>`,
      )}`,
    }),
  };
}

/**
 * The review card: pass a verdict.
 *
 * One form, three radios and a box. Which radios appear is the rule made
 * visible — a reader may only comment, because an approval that anyone who
 * can see the repository could give would make "require review" decorative;
 * and the author never sees Approve, because you cannot approve your own
 * change. Both are refused in `submitReview` too, which is where they are
 * actually enforced.
 *
 * Each verdict carries a `v` chord (`v a`, `v r`, `v c`) that picks the
 * radio and leaves the caret in the box — a prefix nobody hits by accident,
 * and only what a click would do. Submitting stays the button's, or
 * Cmd/Ctrl+Enter from the box (`data-submit-key`), never a bare key.
 */
function reviewCard(ctx: Ctx, repo: Repo, pull: Pull, action: string): Html {
  const user = ctx.auth.user;
  if (user === undefined)
    return card(html`<a href="/signin">Sign in</a> to review this change.`, {
      extra: "mt",
      head: html`${icon("eye")}
        <h2>Review</h2>`,
    });
  if (pull.mergedAt !== null || pull.state === "closed") return html``;
  const writer = canWrite(ctx.app.db, repo, user);
  const isAuthor = pull.authorId === user.id;
  const options: { value: string; label: string; hint: string; key: string }[] =
    [];
  if (writer && !isAuthor)
    options.push({
      value: "approved",
      label: "Approve",
      hint: "This is good to merge.",
      key: "v a",
    });
  if (writer)
    options.push({
      value: "changes_requested",
      label: "Request changes",
      hint: "Blocks the merge until it is withdrawn.",
      key: "v r",
    });
  options.push({
    value: "commented",
    label: "Comment",
    hint: "A note on the change as a whole, with no verdict.",
    key: "v c",
  });

  return card(
    html`<form method="post" action="${action}" data-submit-key>
      <fieldset class="review-verdicts">
        <legend class="sr-only">Your verdict</legend>
        ${options.map(
          (option, i) =>
            html`<label class="check">
              <input
                type="radio"
                name="state"
                value="${option.value}"
                data-shortcut="${option.key}"
                title="${option.label}"
                ${i === options.length - 1 ? raw("checked") : null}
              />
              <span
                >${option.label} <span class="hint">${option.hint}</span></span
              >
            </label>`,
        )}
      </fieldset>
      <label class="sr-only" for="review-body">Review comment</label>
      <textarea
        class="input mt"
        id="review-body"
        name="body"
        rows="3"
        data-grow
        placeholder="Say something about the change as a whole (optional)"
      ></textarea>
      <div class="form-actions">
        ${when(
          isAuthor,
          () =>
            html`<span class="muted small"
              >${icon("alert")} You cannot approve your own pull request.</span
            >`,
        )}
        ${when(
          !writer,
          () =>
            html`<span class="muted small"
              >${icon("alert")} A verdict that gates a merge needs write
              access.</span
            >`,
        )}
        <span class="spacer"></span>
        ${btn("Submit review", { variant: "primary", icon: "check" })}
      </div>
    </form>`,
    {
      extra: "mt review-card",
      head: html`${icon("eye")}
        <h2>Review</h2>`,
    },
  );
}

// ---- the page ----

// GET /:owner/:name/pulls/:number
export async function pullPage(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  // In the studio a change is judged by what it does, not its diff — the
  // same rule `repoHome` follows for an app's own page, and the same rule
  // `changePage` below asks before opening this very page under the
  // studio's own noun. `?mode=dev` on the URL is the escape hatch to the
  // diff, resolved once for `ctx.mode`.
  const studioApp = studioRecord(ctx, repo);
  if (studioApp !== undefined)
    return await studioPull(ctx, repo, pull, studioApp);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const base = repoBase(repo);
  const thread = `${base}/pulls/${pull.number}`;

  // The review gate travels with the status, so the merge box and
  // `mergePull` are answering the same question from the same numbers.
  const { status, from, diff } = await pullDiff(dir, pull, {
    db: ctx.app.db,
    requireReview: repo.requireReview,
  });
  const syntax = await diffSyntax(dir, diff, from, status.headOid);
  // A merged or closed pull is history; the wall is a question about landing.
  const wall =
    pull.mergedAt === null && pull.state === "open"
      ? await wallOf(dir, status.baseOid, status.headOid)
      : undefined;
  const reviewComments = byAnchor(listReviewComments(ctx.app.db, pull.id));
  const mayMerge = canWrite(ctx.app.db, repo, ctx.auth.user);
  const applied = labelsFor(ctx.app.db, pull.id);
  const allLabels = listLabels(ctx.app.db, repo.id);
  const verdicts = listReviews(ctx.app.db, pull.id);
  const by = standings(ctx.app.db, pull, status.headOid);
  // The checks are the deploy runs of the live head, read here for the same
  // reason the review gate is: the box and the merge answer one question.
  const check = checkSummary(ctx.app.db, pull.id, status.headOid);
  const record = getAppByRepo(ctx.app.db, repo.id);
  const isApp = record !== undefined;
  const threads = pullThreads(ctx.app, pull);
  const threadViews = threadStateViews(ctx, repo, threads);
  const unresolved = threads.filter((t) => t.resolvedAt === null).length;

  // A "?rc=path~side~line" link opens an inline comment form at that row.
  const active = ctx.auth.user
    ? parseAnchor(ctx.url.searchParams.get("rc"))
    : undefined;
  const diffOptions: DiffViewOptions = {
    syntax,
    comments: reviewComments,
    threads: threadViews,
    fileLinkBase: `${base}/blob/${status.headOid}`,
    ...(ctx.auth.user ? { reviewBase: thread } : {}),
    ...(active ? { active } : {}),
  };

  const headRepo = pull.crossRepo
    ? getRepoById(ctx.app.db, pull.headRepoId)
    : undefined;
  const headLabel = headRepo
    ? `${headRepo.ownerName}/${headRepo.name}:${pull.headBranch}`
    : pull.headBranch;

  const glyph = originGlyph(repo);
  const talk = conversation(ctx, repo, pull, {
    openVerb: html`wants to merge <span class="mono">${headLabel}</span> into
      <span class="mono">${pull.baseBranch}</span> ·`,
    extra: verdicts.map((review) => reviewEntry(review, status.headOid, glyph)),
  });

  const log = await commitLog(dir, status.headOid, {
    limit: Math.min(Math.max(status.ahead, 1), 100),
  });
  const commits = log.ok ? log.value : [];
  const commitsCard = card(
    commits.length === 0
      ? html`<p class="muted small">No commits to show.</p>`
      : html`<ul class="list">
          ${commits.map(
            (commit) =>
              html`<li>
                <a class="row" href="${base}/commit/${commit.oid}">
                  <span class="row-lead">${avatar(commit.author)}</span>
                  <span class="row-main">
                    <span class="row-title" title="${commit.subject}"
                      >${commit.subject}</span
                    >
                    <span class="row-meta"
                      >${commit.author} · ${time(commit.date)}</span
                    >
                  </span>
                  <span class="row-trail">${sha(commit.oid)}</span>
                </a>
              </li>`,
          )}
        </ul>`,
    {
      pad: false,
      head: html`${icon("commit")}
        <h2>${commits.length} commit${commits.length === 1 ? "" : "s"}</h2>`,
    },
  );

  const body = html`${repoHeader(ctx, repo, "pulls", {
      compact: true,
      ownTitle: true,
    })}
    <div class="issue-head">
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
        <span class="mono">${pull.headBranch} → ${pull.baseBranch}</span>
        ${badge(`${status.ahead} commit${status.ahead === 1 ? "" : "s"}`, {
          variant: "secondary",
        })}
        ${when(pull.crossRepo, () => badge("fork", { icon: "fork" }))}
      </div>
    </div>
    ${when(wall, (w) => wallCard(w))}
    ${mergeBox(ctx, repo, pull, status, mayMerge, by, check, isApp)}
    ${when(record, (r) => lookCard(ctx, repo, r, pull, status.headOid))}
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          stateAction: `${thread}/state`,
          state: pull.state,
          locked: pull.mergedAt !== null,
          closeLabel: "Close pull request",
        })}
        ${reviewCard(ctx, repo, pull, `${thread}/review-state`)}
      </div>
      <aside>
        ${when(isApp, () => previewCard(ctx, repo, pull))}
        ${assigneeCard(ctx, repo, pull, `${thread}/assignee`)}
        ${labelsCard(ctx, repo, pull, applied, allLabels, `${thread}/labels`)}
        <div class="mt">${commitsCard}</div>
        ${crewActivityCard(ctx, repo, pull)}
      </aside>
    </div>
    <div class="files-head">
      <h2 class="mt" id="files">Files changed</h2>
      ${when(
        threads.length > 0,
        () =>
          html`<span class="muted small thread-count"
            >${threads.length} thread${threads.length === 1 ? "" : "s"} ·
            ${unresolved} unresolved</span
          >`,
      )}
    </div>
    ${renderDiff(diff, diffOptions)}
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
    styleCss: labelCss([...allLabels, ...applied]),
    scriptJs: liveClientJs,
  });
}

/**
 * GET /:owner/:name/changes/:number — the studio's own noun for the page
 * `/pulls/:number` already reaches. The page is `studioPull`, rendered from
 * here exactly as `pullPage` renders it: one handler each, never a second
 * copy of the page, and the same `pullContext` for who may see it, so a
 * reader who may not gets the forge's not-found at either address.
 *
 * A viewer the studio's change does not apply to — dev mode, `?mode=dev`,
 * or a repository that is not an app — is sent on to `/pulls/:number`,
 * dev's own address, the same rule `changesList` follows for the list.
 * `/pulls/:number` asked for in studio mode answers where it stands, as it
 * always has; this door adds an address, it never closes one. The forms on
 * the page post where they have always posted.
 */
export async function changePage(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  const record = studioRecord(ctx, repo);
  if (record === undefined)
    return redirect(`${repoBase(repo)}/pulls/${pull.number}${ctx.url.search}`);
  return await studioPull(ctx, repo, pull, record);
}

// GET /:owner/:name/pulls/:number/thread?after=<id>
export function pullThreadFragment(ctx: Ctx): Response {
  return threadFragment(ctx, "pull");
}

// ---- mutations ----

// POST /:owner/:name/pulls/:number/comments
export async function pullCommentSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const bodyText = field(form, "body");
  if (bodyText.trim() === "")
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "A comment needs something in it.",
    });
  const added = await addCommentThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    bodyText,
  );
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: originError(added.error) ?? "That comment could not be posted.",
    });
  return flashTo(ctx, `${dest}#conversation`, { message: "Comment posted." });
}

/** Match the diff viewer's per-file anchor id, so the redirect lands there. */
function fileHashAnchor(path: string): string {
  return "d-" + path.replace(/[^a-zA-Z0-9]+/g, "-");
}

// POST /:owner/:name/pulls/:number/review — a comment anchored to a diff line.
export async function pullReviewSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const anchor = parseAnchor(
    `${field(form, "path")}~${field(form, "side")}~${field(form, "line")}`,
  );
  const bodyText = field(form, "body");
  if (!anchor || bodyText.trim() === "") {
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "That review comment had no line or no text.",
    });
  }
  // The line's content hash is computed server-side from the blob the anchor
  // names, so a stale form can never claim a line said something it did not.
  const added = await addReview(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    {
      body: bodyText,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
    },
  );
  if (!added.ok) {
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        added.error === "bad_anchor"
          ? "That line is no longer part of this diff."
          : added.error === "empty_body"
            ? "A review comment needs some text."
            : added.error === "body_too_long"
              ? "That review comment is too long (64 KB at most)."
              : "That review comment could not be saved.",
    });
  }
  return flashTo(ctx, `${dest}#${fileHashAnchor(anchor.path)}`, {
    message: "Review comment added.",
  });
}

/**
 * Why a merge did not land, in words. The action's error is either an access
 * or lifecycle code, or git's own structured `MergeError` — both are answers
 * the person pressing the button deserves to see.
 */
function mergeFailure(error: AccessError | MergePullError): string {
  if (typeof error !== "string") {
    if (error.kind === "conflict")
      return `The branches conflict in ${error.files.length} file${error.files.length === 1 ? "" : "s"} — merge the base branch in and push again.`;
    if (error.kind === "base_moved")
      return "The base branch moved while merging. Try again.";
    if (error.kind === "unsafe") return "That merge was refused as unsafe.";
    return "Git refused the merge.";
  }
  const fromOrigin = originError(error);
  if (fromOrigin !== undefined) return fromOrigin;
  if (error === "already_merged")
    return "This pull request was already merged.";
  if (error === "closed")
    return "A closed pull request cannot be merged. Reopen it first.";
  // The gate races: the page was rendered with an approval that a push
  // dismissed a second later, or a reviewer asked for changes in between.
  if (error === "review_required")
    return "This pull request needs an approving review of its current head, and does not have one. Nothing was merged.";
  if (error === "checks_required")
    return "This pull request needs a passing deploy of its current head, and does not have one yet. Nothing was merged.";
  if (error === "forbidden" || error === "unauthorized")
    return "You do not have write access to this repository.";
  return "That pull request is no longer here.";
}

// ---- verdicts and threads ----

/**
 * POST /:owner/:name/pulls/:number/review-state — pass a verdict.
 *
 * One endpoint, one verb, and the two refusals that matter get their own
 * sentences: a reader cannot approve (that is what makes "require review"
 * mean anything) and an author cannot approve their own change (that is the
 * whole point of requiring one). Both are decided in `submitReview`; this
 * only puts them into words.
 */
export async function pullReviewStateSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const state = field(form, "state");
  if (!isReviewState(state))
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "Pick approve, request changes, or comment.",
    });
  const bodyText = field(form, "body").trim();
  const submitted = await submitReview(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    { state, ...(bodyText === "" ? {} : { body: bodyText }) },
  );
  if (!submitted.ok) {
    const error = submitted.error;
    return flashTo(ctx, dest, {
      tone: "danger",
      message:
        originError(error) ??
        (error === "self_review"
          ? "You cannot approve your own pull request."
          : error === "forbidden"
            ? "A verdict that gates a merge needs write access. You can still leave a comment."
            : error === "body_too_long"
              ? "That review is too long (64 KB at most)."
              : error === "invalid_state"
                ? "That is not a verdict this forge knows."
                : "That review could not be recorded."),
    });
  }
  return flashTo(ctx, `${dest}#conversation`, {
    message:
      state === "approved"
        ? "Approved."
        : state === "changes_requested"
          ? "Changes requested."
          : "Review posted.",
  });
}

/** POST …/pulls/:number/threads/:anchor/{resolve,unresolve}. */
export function threadResolveSubmit(
  resolved: boolean,
): (ctx: Ctx) => Promise<Response> {
  return async (ctx: Ctx): Promise<Response> => {
    const found = pullContext(ctx);
    if (found instanceof Response) return found;
    if (!ctx.auth.user) return signInFirst(ctx);
    const form = await readForm(ctx, "rw");
    if (form instanceof Response) return form;

    const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
    const anchor = ctx.params.anchor ?? "";
    // The anchor is a hex digest and nothing else; anything shaped
    // differently never reaches a query.
    if (!/^[0-9a-f]{16}$/.test(anchor)) return notFoundPage(ctx);
    const changed = resolveReviewThread(
      ctx.app,
      ctx.auth.user,
      found.repo,
      found.pull,
      anchor,
      resolved,
    );
    if (!changed.ok)
      return flashTo(ctx, `${dest}#files`, {
        tone: "danger",
        message:
          changed.error === "not_found"
            ? "That thread is not here any more."
            : "Only someone in the thread, or a writer, can settle it.",
      });
    return flashTo(ctx, `${dest}#files`, {
      message: resolved ? "Thread resolved." : "Thread reopened.",
    });
  };
}

// POST /:owner/:name/pulls/:number/merge
export async function pullMergeSubmit(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  if (!ctx.auth.user || !canWrite(ctx.app.db, found.repo, ctx.auth.user))
    return new Response("forbidden", { status: 403 });
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const strategy = field(form, "strategy") === "squash" ? "squash" : "merge";
  const dest = `${repoBase(found.repo)}/pulls/${found.pull.number}`;
  const result = await mergePull(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    strategy,
  );
  if (!result.ok) {
    return flashTo(ctx, dest, {
      tone: "danger",
      message: mergeFailure(result.error),
    });
  }
  return flashTo(ctx, dest, { message: "Pull request merged." });
}
