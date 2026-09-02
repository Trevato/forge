/**
 * Issue pages: the list, one issue with its comment thread, and the compose
 * form. Prose is markdown-rendered; state changes and comments are plain
 * form posts. Mobile-first, no JavaScript required.
 */

import {
  addComment,
  openIssue,
  setIssueState,
} from "../../actions/issues.ts";
import { canWrite } from "../../core/repos.ts";
import {
  getIssue,
  labelsFor,
  listComments,
  listIssues,
  type Issue,
  type IssueState,
  type Label,
} from "../../core/issues.ts";
import type { Ctx } from "../../http/context.ts";
import { commentCard } from "../comments.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { crumbsFor, loadRepo, repoNav, repoNotFound, timeAgo } from "./repo.ts";

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return undefined;
  return Number(raw);
}

function stateBadge(state: IssueState): Html {
  return html`<span class="badge" data-state="${state}"
    >${state === "open" ? "Open" : "Closed"}</span
  >`;
}

function labelChips(labels: Label[]): Html {
  return html`${labels.map(
    (l) => html`<span class="label-chip lc-${l.color}">${l.name}</span>`,
  )}`;
}

/** CSS binding each label color to its chip class, for the nonce'd style
 * block. Colors are validated hex at creation and re-checked before embedding. */
function labelCss(colors: Iterable<string>): string {
  let css = "";
  const seen = new Set<string>();
  for (const color of colors) {
    if (seen.has(color) || !/^[0-9a-f]{6}$/.test(color)) continue;
    seen.add(color);
    css += `.lc-${color}{--label:#${color}}`;
  }
  return css;
}

// GET /:owner/:name/issues
export function issuesList(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const state =
    ctx.url.searchParams.get("state") === "closed" ? "closed" : "open";
  const issues = listIssues(ctx.app.db, repo.id, { state, kind: "issue" });
  const base = `/${repo.ownerName}/${repo.name}`;
  const rows = issues.map((issue) => ({
    issue,
    labels: labelsFor(ctx.app.db, issue.id),
  }));
  const colors = rows.flatMap((r) => r.labels.map((l) => l.color));

  const body = html`${repoNav(repo, "issues")}
    <div class="page-head">
      <div class="tabs">
        <a
          class="btn"
          data-size="sm"
          href="${base}/issues?state=open"
          ${state === "open" ? raw('aria-current="page"') : null}
          >Open</a
        >
        <a
          class="btn"
          data-size="sm"
          href="${base}/issues?state=closed"
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
            href="${base}/issues/new"
            >New issue</a
          >`,
      )}
    </div>
    ${issues.length === 0
      ? html`<div class="card empty">No ${state} issues.</div>`
      : html`<div class="card">
          <ul class="list">
            ${rows.map(
              ({ issue, labels }) =>
                html`<li>
                  <a class="row" href="${base}/issues/${issue.number}">
                    <span class="grow">
                      <strong>${issue.title}</strong> ${labelChips(labels)}
                      <br />
                      <span class="muted small"
                        >#${issue.number} opened ${timeAgo(issue.createdAt)} by
                        ${issue.authorName}</span
                      >
                    </span>
                    ${stateBadge(issue.state)}
                  </a>
                </li>`,
            )}
          </ul>
        </div>`}
    ${liveMount({ repo: base })}`;
  return page({
    title: `Issues · ${repo.name}`,
    user: ctx.auth.user,
    theme: ctx.theme,
    crumbs: crumbsFor(repo),
    body,
    styleCss: labelCss(colors),
    scriptJs: liveClientJs,
  });
}

// GET /:owner/:name/issues/new
export function newIssuePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect(`/signin`);
  const body = html`${repoNav(repo, "issues")}
    <div class="narrow-wide">
      <h2>New issue</h2>
      <form method="post" action="/${repo.ownerName}/${repo.name}/issues/new">
        <label for="title">Title</label>
        <input class="input" id="title" name="title" required autofocus />
        <label for="body"
          >Description <span class="muted">(markdown)</span></label
        >
        <textarea class="input" id="body" name="body" rows="10"></textarea>
        <div class="form-actions">
          <button class="btn" data-variant="primary" type="submit">
            Create issue
          </button>
        </div>
      </form>
    </div>`;
  return page({
    title: `New issue · ${repo.name}`,
    user: ctx.auth.user,
    theme: ctx.theme,
    crumbs: crumbsFor(repo),
    body,
  });
}

// POST /:owner/:name/issues/new
export async function newIssueSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect(`/signin`);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const created = openIssue(ctx.app, ctx.auth.user, repo, {
    title: field(form, "title"),
    body: field(form, "body"),
  });
  if (!created.ok)
    return redirect(`/${repo.ownerName}/${repo.name}/issues/new`);
  return redirect(
    `/${repo.ownerName}/${repo.name}/issues/${created.value.number}`,
  );
}

// GET /:owner/:name/issues/:number
export function issuePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const number = parseNumber(ctx.params.number);
  const issue =
    number === undefined ? undefined : getIssue(ctx.app.db, repo.id, number);
  if (!issue || issue.kind !== "issue") return repoNotFound(ctx);

  const comments = listComments(ctx.app.db, issue.id);
  const labels = labelsFor(ctx.app.db, issue.id);
  const mayModerate =
    ctx.auth.user !== undefined &&
    (ctx.auth.user.id === issue.authorId ||
      canWrite(ctx.app.db, repo, ctx.auth.user));
  const base = `/${repo.ownerName}/${repo.name}`;

  const lastCommentId =
    comments.length > 0 ? comments[comments.length - 1]!.id : "";
  const conversation = html`<div id="conversation">
    ${commentCard({
      id: "",
      author: issue.authorName,
      at: issue.createdAt,
      body: issue.body,
      verb: "opened",
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

  const body = html`${repoNav(repo, "issues")}
    <div class="issue-head">
      <h1>${issue.title} <span class="muted">#${issue.number}</span></h1>
      <div class="issue-meta">
        ${stateBadge(issue.state)}
        <span class="muted small"
          >${issue.authorName} opened this ${timeAgo(issue.createdAt)}</span
        >
        ${labelChips(labels)}
      </div>
    </div>
    ${conversation}
    ${liveMount({
      repo: base,
      thread: "issue",
      number: issue.number,
      lastCommentId,
    })}
    ${ctx.auth.user
      ? html`<form
          class="card comment-form"
          method="post"
          action="${base}/issues/${issue.number}/comments"
        >
          <textarea
            class="input"
            name="body"
            rows="4"
            placeholder="Leave a comment"
            required
          ></textarea>
          <div class="form-actions">
            ${when(mayModerate, () =>
              issue.state === "open"
                ? html`<button
                    class="btn"
                    name="intent"
                    value="close"
                    type="submit"
                  >
                    Close issue
                  </button>`
                : html`<button
                    class="btn"
                    name="intent"
                    value="reopen"
                    type="submit"
                  >
                    Reopen
                  </button>`,
            )}
            <span class="spacer"></span>
            <button
              class="btn"
              data-variant="primary"
              name="intent"
              value="comment"
              type="submit"
            >
              Comment
            </button>
          </div>
        </form>`
      : html`<div class="card empty">
          <a href="/signin">Sign in</a> to comment.
        </div>`}`;
  return page({
    title: `${issue.title} · ${repo.name}`,
    user: ctx.auth.user,
    theme: ctx.theme,
    crumbs: crumbsFor(repo),
    body,
    styleCss: labelCss(labels.map((l) => l.color)),
    scriptJs: liveClientJs,
  });
}

// GET /:owner/:name/issues/:number/thread?after=<id> — comment cards after an
// id, for the live client to append. Returns raw HTML, not a full page.
export function issueThreadFragment(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return new Response("", { status: 404 });
  const number = parseNumber(ctx.params.number);
  const issue =
    number === undefined ? undefined : getIssue(ctx.app.db, repo.id, number);
  if (!issue) return new Response("", { status: 404 });
  const after = ctx.url.searchParams.get("after") ?? "";
  const fresh = listComments(ctx.app.db, issue.id).filter((c) => c.id > after);
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

// POST /:owner/:name/issues/:number/comments
export async function issueCommentSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!ctx.auth.user) return redirect(`/signin`);
  const number = parseNumber(ctx.params.number);
  const issue =
    number === undefined ? undefined : getIssue(ctx.app.db, repo.id, number);
  if (!issue) return repoNotFound(ctx);

  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const intent = field(form, "intent");
  const dest = `/${repo.ownerName}/${repo.name}/issues/${issue.number}`;

  const body = field(form, "body");
  if (body.trim() !== "")
    addComment(ctx.app, ctx.auth.user, repo, issue, body);

  // Close/reopen: the action admits the author or a repo writer; anyone
  // else's intent is silently ignored, as the buttons aren't shown to them.
  if (intent === "close" || intent === "reopen")
    setIssueState(
      ctx.app,
      ctx.auth.user,
      repo,
      issue,
      intent === "close" ? "closed" : "open",
    );
  return redirect(dest);
}

export type { Issue };
