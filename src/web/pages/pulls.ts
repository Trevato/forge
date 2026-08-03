/**
 * Pull-request pages: the list, the compose form, and the detail view that
 * carries the conversation, the diff (via the diff viewer), and the merge box.
 * A PR is an issue with a base and head branch, so it reuses the comment
 * thread; only the diff and merge are new.
 */

import { addComment, listComments } from "../../core/issues.ts";
import { canWrite } from "../../core/repos.ts";
import {
  createPull,
  getPull,
  listPulls,
  mergePull,
  pullStatus,
  type Pull,
} from "../../core/pulls.ts";
import { diffRange } from "../../git/diff.ts";
import { mergeBase } from "../../git/merge.ts";
import { listRefs } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { renderDiff } from "../diff-view.ts";
import { diffSyntax } from "../diff-syntax.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { crumbsFor, loadRepo, repoNav, repoNotFound, timeAgo } from "./repo.ts";

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return undefined;
  return Number(raw);
}

async function branchNames(dir: string): Promise<string[]> {
  const refs = await listRefs(dir, "refs/heads/");
  return refs.ok
    ? refs.value.map((r) => r.name.replace("refs/heads/", "")).sort()
    : [];
}

// GET /:owner/:name/pulls
export function pullsList(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const state =
    ctx.url.searchParams.get("state") === "closed" ? "closed" : "open";
  const pulls = listPulls(ctx.app.db, repo.id, state);
  const base = `/${repo.ownerName}/${repo.name}`;

  const body = html`${repoNav(repo, "pulls")}
    <div class="page-head">
      <div class="tabs">
        <a
          class="btn"
          data-size="sm"
          href="${base}/pulls?state=open"
          ${state === "open" ? raw('aria-current="page"') : null}
          >Open</a
        >
        <a
          class="btn"
          data-size="sm"
          href="${base}/pulls?state=closed"
          ${state === "closed" ? raw('aria-current="page"') : null}
          >Closed</a
        >
      </div>
      <span class="spacer"></span>
      ${when(
        ctx.auth.user,
        () =>
          html`<a
            class="btn"
            data-variant="primary"
            data-size="sm"
            href="${base}/pulls/new"
            >New pull request</a
          >`,
      )}
    </div>
    ${pulls.length === 0
      ? html`<div class="card empty">No ${state} pull requests.</div>`
      : html`<div class="card">
          <ul class="list">
            ${pulls.map(
              (pull) =>
                html`<li>
                  <a class="row" href="${base}/pulls/${pull.number}">
                    <span class="grow">
                      <strong>${pull.title}</strong>
                      <br />
                      <span class="muted small"
                        >#${pull.number} ${pull.headBranch} →
                        ${pull.baseBranch}, opened ${timeAgo(pull.createdAt)} by
                        ${pull.authorName}</span
                      >
                    </span>
                    ${pullBadge(pull)}
                  </a>
                </li>`,
            )}
          </ul>
        </div>`}`;
  return page({
    title: `Pull requests · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body,
  });
}

function pullBadge(pull: Pull): Html {
  if (pull.mergedAt !== null)
    return html`<span class="badge" data-pr="merged">Merged</span>`;
  if (pull.state === "closed")
    return html`<span class="badge" data-state="closed">Closed</span>`;
  return html`<span class="badge" data-state="open">Open</span>`;
}

// GET /:owner/:name/pulls/new
export async function newPullPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect("/signin");
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const branches = await branchNames(dir);
  const baseDefault = repo.defaultBranch;
  const headDefault = branches.find((b) => b !== baseDefault) ?? "";

  const body = html`${repoNav(repo, "pulls")}
    <div class="narrow-wide">
      <h2>New pull request</h2>
      ${branches.length < 2
        ? html`<div class="card empty">
            Push at least two branches to open a pull request.
          </div>`
        : html`<form
            method="post"
            action="/${repo.ownerName}/${repo.name}/pulls/new"
          >
            <div class="branch-pick">
              <label
                >base
                <select class="input" name="base">
                  ${branchOptions(branches, baseDefault)}
                </select></label
              >
              <span class="muted">←</span>
              <label
                >compare
                <select class="input" name="head">
                  ${branchOptions(branches, headDefault)}
                </select></label
              >
            </div>
            <label for="title">Title</label>
            <input class="input" id="title" name="title" required />
            <label for="body"
              >Description <span class="muted">(markdown)</span></label
            >
            <textarea class="input" id="body" name="body" rows="8"></textarea>
            <div class="form-actions">
              <button class="btn" data-variant="primary" type="submit">
                Create pull request
              </button>
            </div>
          </form>`}
    </div>`;
  return page({
    title: `New pull request · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body,
  });
}

function branchOptions(branches: string[], selected: string): Html {
  return html`${branches.map(
    (b) =>
      html`<option value="${b}" ${b === selected ? raw("selected") : null}>
        ${b}
      </option>`,
  )}`;
}

// POST /:owner/:name/pulls/new
export async function newPullSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect("/signin");
  const form = await readForm(ctx);
  if (form instanceof Response) return form;
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);

  const created = await createPull(ctx.app.db, dir, {
    repoId: repo.id,
    authorId: ctx.auth.user.id,
    title: field(form, "title"),
    body: field(form, "body"),
    baseBranch: field(form, "base"),
    headBranch: field(form, "head"),
  });
  if (!created.ok) {
    const messages: Record<string, string> = {
      empty_title: "A title is required.",
      same_branch: "Base and compare branches must differ.",
      unknown_base: "That base branch does not exist.",
      unknown_head: "That compare branch does not exist.",
      nothing_to_merge: "The compare branch has no commits beyond base.",
      invalid_branch: "Invalid branch name.",
    };
    const base = `/${repo.ownerName}/${repo.name}`;
    return page({
      title: "New pull request",
      user: ctx.auth.user,
      crumbs: crumbsFor(repo),
      body: html`${repoNav(repo, "pulls")}
        <div class="narrow-wide">
          <p class="error-note">
            ${messages[created.error] ?? "Could not open the pull request."}
          </p>
          <a class="btn" href="${base}/pulls/new">Back</a>
        </div>`,
    });
  }
  ctx.app.bus.append({
    kind: "pull.opened",
    repoId: repo.id,
    actorId: ctx.auth.user.id,
    payload: { number: created.value.number },
  });
  return redirect(
    `/${repo.ownerName}/${repo.name}/pulls/${created.value.number}`,
  );
}

// GET /:owner/:name/pulls/:number
export async function pullPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return repoNotFound(ctx);

  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const status = await pullStatus(dir, pull);
  const from =
    (await mergeBase(dir, status.baseOid, status.headOid)) ?? status.baseOid;
  const diffResult = await diffRange(dir, from, status.headOid);
  const diff = diffResult.ok
    ? diffResult.value
    : { files: [], additions: 0, deletions: 0 };
  const syntax = await diffSyntax(dir, diff, from, status.headOid);
  const comments = listComments(ctx.app.db, pull.id);
  const mayMerge = canWrite(repo, ctx.auth.user);
  const base = `/${repo.ownerName}/${repo.name}`;

  const conversation = html`<div class="card comment">
      <div class="comment-head">
        <strong>${pull.authorName}</strong>
        <span class="muted small"
          >wants to merge ${pull.headBranch} into ${pull.baseBranch} ·
          ${timeAgo(pull.createdAt)}</span
        >
      </div>
      <div class="md comment-body">
        ${pull.body.trim() === ""
          ? html`<p class="muted">No description.</p>`
          : renderMarkdown(pull.body)}
      </div>
    </div>
    ${comments.map(
      (c) =>
        html`<div class="card comment">
          <div class="comment-head">
            <strong>${c.authorName}</strong>
            <span class="muted small">commented ${timeAgo(c.createdAt)}</span>
          </div>
          <div class="md comment-body">${renderMarkdown(c.body)}</div>
        </div>`,
    )}`;

  const body = html`${repoNav(repo, "pulls")}
    <div class="issue-head">
      <h1>${pull.title} <span class="muted">#${pull.number}</span></h1>
      <div class="issue-meta">
        ${pullBadge(pull)}
        <span class="muted small mono"
          >${pull.headBranch} → ${pull.baseBranch}</span
        >
        <span class="muted small"
          >${status.ahead} commit${status.ahead === 1 ? "" : "s"}</span
        >
      </div>
    </div>
    ${conversation} ${mergeBox(pull, status, mayMerge, base)}
    <h2 class="mt">Files changed</h2>
    ${renderDiff(diff, syntax)}
    ${ctx.auth.user
      ? html`<form
          class="card comment-form"
          method="post"
          action="${base}/pulls/${pull.number}/comments"
        >
          <textarea
            class="input"
            name="body"
            rows="4"
            placeholder="Leave a comment"
            required
          ></textarea>
          <div class="form-actions">
            <span class="spacer"></span>
            <button class="btn" data-variant="primary" type="submit">
              Comment
            </button>
          </div>
        </form>`
      : null}`;
  return page({
    title: `${pull.title} · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body,
  });
}

function mergeBox(
  pull: Pull,
  status: Awaited<ReturnType<typeof pullStatus>>,
  mayMerge: boolean,
  base: string,
): Html {
  if (pull.mergedAt !== null) {
    return html`<div class="card merge-box" data-status="merged">
      <strong>Merged.</strong>
      <span class="muted"
        >${pull.headBranch} was merged into ${pull.baseBranch}.</span
      >
    </div>`;
  }
  if (pull.state === "closed") {
    return html`<div class="card merge-box">
      <strong>Closed</strong> without merging.
    </div>`;
  }
  if (!status.mergeable) {
    const reason =
      status.ahead === 0
        ? "Nothing to merge — base already contains these commits."
        : status.conflicts.length > 0
          ? html`Conflicts in ${status.conflicts.length}
            file${status.conflicts.length === 1 ? "" : "s"}.`
          : "This branch cannot be merged automatically.";
    return html`<div class="card merge-box" data-status="blocked">
      <strong>Can't merge.</strong> <span class="muted">${reason}</span>
    </div>`;
  }
  return html`<div class="card merge-box" data-status="ready">
    <span class="merge-ready"
      >✓ Ready to merge — no conflicts with ${pull.baseBranch}.</span
    >
    ${mayMerge
      ? html`<form
          method="post"
          action="${base}/pulls/${pull.number}/merge"
          class="merge-form"
        >
          <select class="input" name="strategy">
            <option value="merge">Merge commit</option>
            <option value="squash">Squash and merge</option>
          </select>
          <button class="btn" data-variant="primary" type="submit">
            Merge pull request
          </button>
        </form>`
      : html`<span class="muted small">You need write access to merge.</span>`}
  </div>`;
}

// POST /:owner/:name/pulls/:number/merge
export async function pullMergeSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user || !canWrite(repo, ctx.auth.user))
    return new Response("forbidden", { status: 403 });
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return repoNotFound(ctx);
  const form = await readForm(ctx);
  if (form instanceof Response) return form;

  const strategy = field(form, "strategy") === "squash" ? "squash" : "merge";
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const merged = await mergePull(ctx.app.db, dir, pull, {
    strategy,
    message:
      strategy === "squash"
        ? `${pull.title} (#${pull.number})`
        : `Merge pull request #${pull.number} from ${pull.headBranch}\n\n${pull.title}`,
    actorId: ctx.auth.user.id,
    author: {
      name: ctx.auth.user.displayName || ctx.auth.user.username,
      email: ctx.auth.user.email,
    },
  });
  const dest = `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`;
  if (merged.ok) {
    ctx.app.bus.append({
      kind: "pull.merged",
      repoId: repo.id,
      actorId: ctx.auth.user.id,
      payload: {
        number: pull.number,
        strategy,
        mergeOid: merged.value.mergeOid,
      },
    });
  }
  return redirect(dest);
}

// POST /:owner/:name/pulls/:number/comments
export async function pullCommentSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect("/signin");
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return repoNotFound(ctx);
  const form = await readForm(ctx);
  if (form instanceof Response) return form;

  const bodyText = field(form, "body");
  if (bodyText.trim() !== "") {
    const added = addComment(ctx.app.db, {
      issueId: pull.id,
      authorId: ctx.auth.user.id,
      body: bodyText,
    });
    if (added.ok) {
      ctx.app.bus.append({
        kind: "pull.commented",
        repoId: repo.id,
        actorId: ctx.auth.user.id,
        payload: { number: pull.number },
      });
    }
  }
  return redirect(`/${repo.ownerName}/${repo.name}/pulls/${pull.number}`);
}
