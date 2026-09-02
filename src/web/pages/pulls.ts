/**
 * Pull-request pages: the list, the compose form, and the detail view that
 * carries the conversation, the diff (via the diff viewer), and the merge box.
 * A PR is an issue with a base and head branch, so it reuses the comment
 * thread; only the diff and merge are new.
 */

import { addComment } from "../../actions/issues.ts";
import { addReview, mergePull, openPull } from "../../actions/pulls.ts";
import { listComments } from "../../core/issues.ts";
import {
  byAnchor,
  listReviewComments,
  type Side,
} from "../../core/reviews.ts";
import { canWrite, getRepoById } from "../../core/repos.ts";
import {
  getPull,
  listPulls,
  pullStatus,
  type Pull,
} from "../../core/pulls.ts";
import { diffRange } from "../../git/diff.ts";
import { mergeBase } from "../../git/merge.ts";
import { listRefs } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { commentCard } from "../comments.ts";
import { renderDiff, type DiffViewOptions } from "../diff-view.ts";
import { diffSyntax } from "../diff-syntax.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { crumbsFor, loadRepo, repoNav, repoNotFound, timeAgo } from "./repo.ts";

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return undefined;
  return Number(raw);
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
        </div>`}
    ${liveMount({ repo: base })}`;
  return page({
    title: `Pull requests · ${repo.name}`,
    user: ctx.auth.user,
    theme: ctx.theme,
    crumbs: crumbsFor(repo),
    body,
    scriptJs: liveClientJs,
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
  const headBranches = await branchNames(dir);

  // A fork proposes upstream by default: base = the parent, compare = this
  // fork. `?self=1` opens a plain within-repo PR instead.
  const parent =
    repo.forkParentId !== null && ctx.url.searchParams.get("self") === null
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;
  const cross = parent !== undefined;
  const baseBranches = cross
    ? await branchNames(
        repoDir(ctx.app.reposRoot, parent.ownerName, parent.name),
      )
    : headBranches;
  const baseDefault = cross ? parent.defaultBranch : repo.defaultBranch;
  const headDefault =
    headBranches.find((b) => !cross && b !== baseDefault) ??
    headBranches[0] ??
    "";

  const enoughBranches = cross
    ? baseBranches.length >= 1 && headBranches.length >= 1
    : headBranches.length >= 2;

  const body = html`${repoNav(repo, "pulls")}
    <div class="narrow-wide">
      <h2>New pull request</h2>
      ${cross
        ? html`<p class="muted small">
            Proposing <strong>${repo.ownerName}/${repo.name}</strong> →
            <strong>${parent.ownerName}/${parent.name}</strong>.
            <a href="/${repo.ownerName}/${repo.name}/pulls/new?self=1"
              >Open one within this fork instead.</a
            >
          </p>`
        : null}
      ${!enoughBranches
        ? html`<div class="card empty">
            Push at least two branches to open a pull request.
          </div>`
        : html`<form
            method="post"
            action="/${repo.ownerName}/${repo.name}/pulls/new"
          >
            <input
              type="hidden"
              name="baseRepo"
              value="${cross ? "parent" : "self"}"
            />
            <div class="branch-pick">
              <label
                >base
                ${when(
                  parent,
                  (p) =>
                    html`<span class="muted mono"
                      >${p.ownerName}/${p.name}:</span
                    >`,
                )}
                <select class="input" name="base">
                  ${branchOptions(baseBranches, baseDefault)}
                </select></label
              >
              <span class="muted">←</span>
              <label
                >compare
                <select class="input" name="head">
                  ${branchOptions(headBranches, headDefault)}
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
    theme: ctx.theme,
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
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // A fork proposing upstream creates the PR in the PARENT repo, with this
  // fork as the head. Otherwise it's a plain within-repo PR.
  const parent =
    field(form, "baseRepo") === "parent" && repo.forkParentId !== null
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;
  const baseRepo = parent ?? repo;

  const created = await openPull(ctx.app, ctx.auth.user, baseRepo, {
    title: field(form, "title"),
    body: field(form, "body"),
    baseBranch: field(form, "base"),
    headBranch: field(form, "head"),
    ...(parent ? { headRepo: repo } : {}),
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
    const back = `/${repo.ownerName}/${repo.name}`;
    return page({
      title: "New pull request",
      user: ctx.auth.user,
      theme: ctx.theme,
      crumbs: crumbsFor(repo),
      body: html`${repoNav(repo, "pulls")}
        <div class="narrow-wide">
          <p class="error-note">
            ${messages[created.error] ?? "Could not open the pull request."}
          </p>
          <a class="btn" href="${back}/pulls/new">Back</a>
        </div>`,
    });
  }
  return redirect(
    `/${baseRepo.ownerName}/${baseRepo.name}/pulls/${created.value.number}`,
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
  const reviewComments = byAnchor(listReviewComments(ctx.app.db, pull.id));
  const mayMerge = canWrite(ctx.app.db, repo, ctx.auth.user);
  const base = `/${repo.ownerName}/${repo.name}`;
  const reviewBase = `${base}/pulls/${pull.number}`;

  // A "?rc=path~side~line" link opens an inline comment form at that row.
  const active = ctx.auth.user
    ? parseAnchor(ctx.url.searchParams.get("rc"))
    : undefined;
  const diffOptions: DiffViewOptions = {
    syntax,
    comments: reviewComments,
    ...(ctx.auth.user ? { reviewBase } : {}),
    ...(active ? { active } : {}),
  };

  const lastCommentId =
    comments.length > 0 ? comments[comments.length - 1]!.id : "";
  const headRepo = pull.crossRepo
    ? getRepoById(ctx.app.db, pull.headRepoId)
    : undefined;
  const headLabel = headRepo
    ? `${headRepo.ownerName}/${headRepo.name}:${pull.headBranch}`
    : pull.headBranch;
  const conversation = html`<div id="conversation">
    ${commentCard({
      id: "",
      author: pull.authorName,
      at: pull.createdAt,
      body: pull.body,
      verb: html`wants to merge ${headLabel} into ${pull.baseBranch} ·`,
    })}
    ${comments.map((c) =>
      commentCard({
        id: c.id,
        author: c.authorName,
        at: c.createdAt,
        body: c.body,
        verb: "commented",
      }),
    )}
  </div>`;

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
    ${renderDiff(diff, diffOptions)}
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
      : null}
    ${liveMount({
      repo: base,
      thread: "pull",
      number: pull.number,
      lastCommentId,
    })}`;
  return page({
    title: `${pull.title} · ${repo.name}`,
    user: ctx.auth.user,
    theme: ctx.theme,
    crumbs: crumbsFor(repo),
    body,
    scriptJs: liveClientJs,
  });
}

// GET /:owner/:name/pulls/:number/thread?after=<id> — new conversation comments.
export function pullThreadFragment(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return new Response("", { status: 404 });
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return new Response("", { status: 404 });
  const after = ctx.url.searchParams.get("after") ?? "";
  const fresh = listComments(ctx.app.db, pull.id).filter((c) => c.id > after);
  const fragment = html`${fresh.map((c) =>
    commentCard({
      id: c.id,
      author: c.authorName,
      at: c.createdAt,
      body: c.body,
      verb: "commented",
    }),
  )}`;
  return new Response(fragment.text, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'none'; sandbox",
    },
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
  if (!ctx.auth.user || !canWrite(ctx.app.db, repo, ctx.auth.user))
    return new Response("forbidden", { status: 403 });
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return repoNotFound(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const strategy = field(form, "strategy") === "squash" ? "squash" : "merge";
  await mergePull(ctx.app, ctx.auth.user, repo, pull, strategy);
  return redirect(`/${repo.ownerName}/${repo.name}/pulls/${pull.number}`);
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
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const bodyText = field(form, "body");
  if (bodyText.trim() !== "")
    addComment(ctx.app, ctx.auth.user, repo, pull, bodyText);
  return redirect(`/${repo.ownerName}/${repo.name}/pulls/${pull.number}`);
}

// POST /:owner/:name/pulls/:number/review — a comment anchored to a diff line.
export async function pullReviewSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect("/signin");
  const number = parseNumber(ctx.params.number);
  const pull =
    number === undefined ? undefined : getPull(ctx.app.db, repo.id, number);
  if (!pull) return repoNotFound(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const anchor = parseAnchor(
    `${field(form, "path")}~${field(form, "side")}~${field(form, "line")}`,
  );
  const bodyText = field(form, "body");
  const dest = `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`;
  if (anchor && bodyText.trim() !== "") {
    // Anchored to the head the reviewer is looking at, plus the line's content
    // hash so a later force-push re-anchors or marks the comment outdated.
    await addReview(ctx.app, ctx.auth.user, repo, pull, {
      body: bodyText,
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
      lineHash: field(form, "lineHash"),
    });
  }
  return redirect(`${dest}#${fileHashAnchor(anchor?.path ?? "")}`);
}

/** Match the diff viewer's per-file anchor id, so the redirect lands there. */
function fileHashAnchor(path: string): string {
  return "d-" + path.replace(/[^a-zA-Z0-9]+/g, "-");
}
