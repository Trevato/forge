/**
 * One pull request: the conversation, the merge box, the commits it carries,
 * and the diff with inline review. This is the highest-value screen in the
 * product, so the merge box is an explicit state machine — one card variant
 * per state, each saying what is true and what you can do about it — and the
 * diff is given the full width it needs.
 */

import { addComment } from "../../actions/issues.ts";
import type { AccessError } from "../../actions/access.ts";
import { addReview, mergePull } from "../../actions/pulls.ts";
import { labelsFor, listLabels } from "../../core/issues.ts";
import {
  pullDiff,
  type MergePullError,
  type Pull,
  type PullStatus,
} from "../../core/pulls.ts";
import { getPull } from "../../core/pulls.ts";
import { byAnchor, listReviewComments, type Side } from "../../core/reviews.ts";
import { canWrite, getRepoById, type Repo } from "../../core/repos.ts";
import { commitLog } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
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
import { renderDiff, type DiffViewOptions } from "../diff-view.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  avatar,
  badge,
  btn,
  card,
  icon,
  labelCss,
  listCard,
  sha,
  stateBadge,
  time,
  userLink,
} from "../ui.ts";
import {
  composer,
  conversation,
  labelsCard,
  parseNumber,
  threadFragment,
} from "./thread.ts";
import { pullState } from "./pulls.ts";

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

// ---- the merge box ----

/**
 * Five states, five cards. Every one names the situation, gives the reason,
 * and offers exactly the actions that are actually available.
 */
function mergeBox(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
  status: PullStatus,
  mayMerge: boolean,
): Html {
  const thread = `${repoBase(repo)}/pulls/${pull.number}`;
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
        </div>`,
      { tone: "danger", extra: "merge-box" },
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

// ---- the page ----

// GET /:owner/:name/pulls/:number
export async function pullPage(ctx: Ctx): Promise<Response> {
  const found = pullContext(ctx);
  if (found instanceof Response) return found;
  const { repo, pull } = found;
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const base = repoBase(repo);
  const thread = `${base}/pulls/${pull.number}`;

  const { status, from, diff } = await pullDiff(dir, pull);
  const syntax = await diffSyntax(dir, diff, from, status.headOid);
  const reviewComments = byAnchor(listReviewComments(ctx.app.db, pull.id));
  const mayMerge = canWrite(ctx.app.db, repo, ctx.auth.user);
  const applied = labelsFor(ctx.app.db, pull.id);
  const allLabels = listLabels(ctx.app.db, repo.id);

  // A "?rc=path~side~line" link opens an inline comment form at that row.
  const active = ctx.auth.user
    ? parseAnchor(ctx.url.searchParams.get("rc"))
    : undefined;
  const diffOptions: DiffViewOptions = {
    syntax,
    comments: reviewComments,
    ...(ctx.auth.user ? { reviewBase: thread } : {}),
    ...(active ? { active } : {}),
  };

  const headRepo = pull.crossRepo
    ? getRepoById(ctx.app.db, pull.headRepoId)
    : undefined;
  const headLabel = headRepo
    ? `${headRepo.ownerName}/${headRepo.name}:${pull.headBranch}`
    : pull.headBranch;

  const talk = conversation(ctx, repo, pull, {
    openVerb: html`wants to merge <span class="mono">${headLabel}</span> into
      <span class="mono">${pull.baseBranch}</span> ·`,
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

  const body = html`${repoHeader(ctx, repo, "pulls", { compact: true, ownTitle: true })}
    <div class="issue-head">
      <h1>${pull.title} <span class="number">#${pull.number}</span></h1>
      <div class="issue-meta">
        ${stateBadge(pullState(pull))}
        <span
          >${userLink(pull.authorName)} opened this
          ${time(pull.createdAt)}</span
        >
        <span class="mono">${pull.headBranch} → ${pull.baseBranch}</span>
        ${badge(`${status.ahead} commit${status.ahead === 1 ? "" : "s"}`, {
          variant: "secondary",
        })}
        ${when(pull.crossRepo, () => badge("fork", { icon: "fork" }))}
      </div>
    </div>
    ${mergeBox(ctx, repo, pull, status, mayMerge)}
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
      <aside>
        ${labelsCard(ctx, repo, pull, applied, allLabels, `${thread}/labels`)}
        <div class="mt">${commitsCard}</div>
      </aside>
    </div>
    <h2 class="mt" id="files">Files changed</h2>
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
    palette: repoPalette(repo),
    body,
    styleCss: labelCss([...allLabels, ...applied]),
    scriptJs: liveClientJs,
  });
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
  const added = addComment(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.pull,
    bodyText,
  );
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "That comment could not be posted.",
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
function mergeFailure(
  error: AccessError | MergePullError,
): string {
  if (typeof error !== "string") {
    if (error.kind === "conflict")
      return `The branches conflict in ${error.files.length} file${error.files.length === 1 ? "" : "s"} — merge the base branch in and push again.`;
    if (error.kind === "base_moved")
      return "The base branch moved while merging. Try again.";
    if (error.kind === "unsafe") return "That merge was refused as unsafe.";
    return "Git refused the merge.";
  }
  if (error === "already_merged") return "This pull request was already merged.";
  if (error === "closed")
    return "A closed pull request cannot be merged. Reopen it first.";
  if (error === "forbidden" || error === "unauthorized")
    return "You do not have write access to this repository.";
  return "That pull request is no longer here.";
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
