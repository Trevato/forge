/**
 * Issue pages: the list with its filters, one issue with its timeline, and
 * the compose form. Prose is markdown; every state change is a plain form
 * post to its own endpoint. Mobile-first, no JavaScript required.
 */

import { addComment, openIssue } from "../../actions/issues.ts";
import {
  countComments,
  countIssues,
  labelsFor,
  listIssues,
  listLabels,
  type Issue,
  type IssueState,
  type Label,
} from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
  stickyAction,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import {
  btn,
  empty,
  icon,
  labelChip,
  labelCss,
  listCard,
  pager,
  seg,
  stateBadge,
  time,
  userLink,
  userTag,
  field as formField,
} from "../ui.ts";
import {
  composer,
  conversation,
  labelsCard,
  parseNumber,
  threadContext,
  threadFragment,
} from "./thread.ts";

const PER_PAGE = 25;

// ---- the list ----

interface ListQuery {
  state: IssueState | "all";
  label: string;
  author: string;
  q: string;
  cursor: number | undefined;
}

function readQuery(ctx: Ctx): ListQuery {
  const params = ctx.url.searchParams;
  const raw = params.get("state");
  const cursor = Number(params.get("cursor"));
  return {
    state: raw === "closed" ? "closed" : raw === "all" ? "all" : "open",
    label: params.get("label") ?? "",
    author: params.get("author") ?? "",
    q: params.get("q") ?? "",
    cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : undefined,
  };
}

/** Rebuild the current URL with one facet changed — filters compose instead
 * of replacing each other. */
function withFacet(
  base: string,
  query: ListQuery,
  patch: Partial<Record<"state" | "label" | "author" | "q", string>>,
  cursor?: number,
): string {
  const params = new URLSearchParams();
  const state = patch.state ?? query.state;
  if (state !== "open") params.set("state", state);
  const label = patch.label ?? query.label;
  if (label !== "") params.set("label", label);
  const author = patch.author ?? query.author;
  if (author !== "") params.set("author", author);
  const q = patch.q ?? query.q;
  if (q !== "") params.set("q", q);
  if (cursor !== undefined) params.set("cursor", String(cursor));
  const text = params.toString();
  return text === "" ? base : `${base}?${text}`;
}

function filterBar(
  base: string,
  query: ListQuery,
  labels: Label[],
  counts: { open: number; closed: number },
): Html {
  return html`<div class="filters">
      ${seg([
        {
          label: "Open",
          href: withFacet(base, query, { state: "open" }),
          current: query.state === "open",
          count: counts.open,
        },
        {
          label: "Closed",
          href: withFacet(base, query, { state: "closed" }),
          current: query.state === "closed",
          count: counts.closed,
        },
        {
          label: "All",
          href: withFacet(base, query, { state: "all" }),
          current: query.state === "all",
        },
      ])}
      <form method="get" action="${base}" role="search">
        ${when(query.state !== "open", () => hidden("state", query.state))}
        ${when(query.label !== "", () => hidden("label", query.label))}
        ${when(query.author !== "", () => hidden("author", query.author))}
        <input
          class="input search"
          type="search"
          name="q"
          value="${query.q}"
          placeholder="Search titles"
          aria-label="Search titles"
        />
        ${btn("Search", { size: "sm", variant: "outline" })}
      </form>
      <span class="spacer"></span>
      ${when(query.author !== "" || query.label !== "" || query.q !== "", () =>
        btn("Clear filters", {
          href: withFacet(base, query, { label: "", author: "", q: "" }),
          size: "sm",
          variant: "ghost",
          icon: "x",
        }),
      )}
    </div>
    ${when(
      labels.length > 0,
      () =>
        html`<div class="bar mb">
          ${labels.map((l) =>
            query.label.toLowerCase() === l.name.toLowerCase()
              ? html`<a
                  class="label lc-${l.color}"
                  href="${withFacet(base, query, { label: "" })}"
                  aria-current="true"
                  title="Remove this filter"
                  >${l.name} ✕</a
                >`
              : labelChip(l, withFacet(base, query, { label: l.name })),
          )}
        </div>`,
    )}`;
}

function hidden(name: string, value: string): Html {
  return html`<input type="hidden" name="${name}" value="${value}" />`;
}

/**
 * One issue or pull row: state as the colour of the leading icon, title with
 * its label chips, one metadata line, and the comment count trailing. There
 * is no state badge — the list is already filtered by state, and a badge that
 * repeats the filter is noise. Nothing inside is a link: the row *is* one.
 */
export function threadRow(
  base: string,
  segment: "issues" | "pulls",
  issue: Issue,
  labels: Label[],
  state: "open" | "closed" | "merged",
  meta: Html,
  comments = 0,
): Html {
  return html`<li>
    <a
      class="row"
      data-state="${state}"
      data-nav
      tabindex="-1"
      href="${base}/${segment}/${issue.number}"
    >
      <span class="row-lead"
        >${icon(
          state === "merged"
            ? "merge"
            : segment === "pulls"
              ? "pull"
              : state === "closed"
                ? "issueClosed"
                : "issue",
        )}</span
      >
      <span class="row-main">
        <span class="row-title" title="${issue.title}"
          >${issue.title}${labels.map((l) => html` ${labelChip(l)}`)}</span
        >
        <span class="row-meta">${meta}</span>
      </span>
      ${when(
        comments > 0,
        () =>
          html`<span class="row-trail"
            ><span class="count" title="${`${comments} comments`}"
              >${icon("comment")}${comments}</span
            ></span
          >`,
      )}
    </a>
  </li>`;
}

// GET /:owner/:name/issues
export function issuesList(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const query = readQuery(ctx);
  const db = ctx.app.db;

  const issues = listIssues(db, repo.id, {
    state: query.state,
    kind: "issue",
    limit: PER_PAGE,
    ...(query.label !== "" ? { label: query.label } : {}),
    ...(query.author !== "" ? { author: query.author } : {}),
    ...(query.q !== "" ? { query: query.q } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
  });
  const rows = issues.map((issue) => ({
    issue,
    labels: labelsFor(db, issue.id),
    comments: countComments(db, issue.id),
  }));
  const repoLabels = listLabels(db, repo.id);
  const counts = {
    open: countIssues(db, repo.id, "issue", "open"),
    closed: countIssues(db, repo.id, "issue", "closed"),
  };

  const newIssue = ctx.auth.user
    ? btn("New issue", {
        href: `${base}/issues/new`,
        variant: "primary",
        icon: "plus",
        shortcut: "c",
      })
    : btn("Sign in to open an issue", { href: "/signin" });

  const list =
    rows.length === 0
      ? empty({
          icon: "issue",
          title:
            query.q !== "" || query.label !== "" || query.author !== ""
              ? "No issues match those filters"
              : query.state === "closed"
                ? "No closed issues"
                : query.state === "all"
                  ? "No issues yet"
                  : "No open issues",
          note:
            query.state === "open" && counts.closed > 0
              ? "Everything here is closed."
              : "Issues are how work gets described before it gets done.",
          action: newIssue,
        })
      : listCard(
          rows.map(({ issue, labels, comments }) =>
            threadRow(
              base,
              "issues",
              issue,
              labels,
              issue.state,
              html`#${issue.number} opened ${time(issue.createdAt)} by
              ${userTag(issue.authorName)}`,
              comments,
            ),
          ),
        );

  const lastNumber = issues[issues.length - 1]?.number;
  const body = html`${repoHeader(ctx, repo, "issues")}
    <div class="mt">
      ${filterBar(`${base}/issues`, query, repoLabels, counts)} ${list}
      ${pager(
        issues.length === PER_PAGE && lastNumber !== undefined
          ? { next: withFacet(`${base}/issues`, query, {}, lastNumber) }
          : {},
      )}
    </div>
    ${when(ctx.auth.user !== undefined, () => stickyAction(newIssue))}
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: `Issues · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: labelCss([...repoLabels, ...rows.flatMap((r) => r.labels)]),
    scriptJs: liveClientJs,
  });
}

// ---- compose ----

function newIssueForm(
  repo: Repo,
  values: { title: string; body: string },
  error?: string,
): Html {
  return html`<div class="narrow-wide mt">
    <form method="post" action="${repoBase(repo)}/issues/new">
      ${when(error, (message) => html`<p class="error-note">${message}</p>`)}
      ${formField({
        label: "Title",
        name: "title",
        value: values.title,
        required: true,
        autofocus: true,
        ...(error ? { error } : {}),
      })}
      ${formField({
        label: "Description",
        name: "body",
        type: "textarea",
        rows: 10,
        value: values.body,
        hint: "Markdown is supported.",
      })}
      <div class="form-actions">
        ${btn("Create issue", { variant: "primary", icon: "issue" })}
        ${btn("Cancel", {
          href: `${repoBase(repo)}/issues`,
          variant: "ghost",
        })}
      </div>
    </form>
  </div>`;
}

// GET /:owner/:name/issues/new
export function newIssuePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  return page({
    ctx,
    title: `New issue · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body: html`${repoHeader(ctx, repo, "issues", {
        compact: true,
        ownTitle: true,
      })}
      <h1 class="mt">New issue</h1>
      ${newIssueForm(repo, { title: "", body: "" })}`,
  });
}

// POST /:owner/:name/issues/new
export async function newIssueSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const values = { title: field(form, "title"), body: field(form, "body") };
  const created = openIssue(ctx.app, ctx.auth.user, repo, values);
  if (!created.ok) {
    // Nothing typed is ever lost: the form comes back exactly as it was sent.
    const message =
      created.error === "empty_title"
        ? "An issue needs a title."
        : "You cannot open an issue here.";
    return page(
      {
        ctx,
        title: `New issue · ${repo.name}`,
        crumbs: crumbsFor(repo),
        body: html`${repoHeader(ctx, repo, "issues", {
            compact: true,
            ownTitle: true,
          })}
          <h1 class="mt">New issue</h1>
          ${newIssueForm(repo, values, message)}`,
      },
      422,
    );
  }
  return flashTo(ctx, `${repoBase(repo)}/issues/${created.value.number}`, {
    message: `Issue #${created.value.number} opened.`,
  });
}

// ---- one issue ----

// GET /:owner/:name/issues/:number
export function issuePage(ctx: Ctx): Response {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  const { repo, issue } = found;
  const base = repoBase(repo);
  const thread = `${base}/issues/${issue.number}`;

  const applied = labelsFor(ctx.app.db, issue.id);
  const all = listLabels(ctx.app.db, repo.id);
  const talk = conversation(ctx, repo, issue, { openVerb: "opened this" });

  const body = html`${repoHeader(ctx, repo, "issues", {
      compact: true,
      ownTitle: true,
    })}
    <div class="issue-head">
      <h1>${issue.title} <span class="number">#${issue.number}</span></h1>
      <div class="issue-meta">
        ${stateBadge(issue.state)}
        <span
          >${userLink(issue.authorName)} opened this
          ${time(issue.createdAt)}</span
        >
      </div>
    </div>
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          stateAction: `${thread}/state`,
          state: issue.state,
          kind: "issue",
        })}
      </div>
      <aside>
        ${labelsCard(ctx, repo, issue, applied, all, `${thread}/labels`)}
      </aside>
    </div>
    ${liveMount({
      repo: base,
      thread: "issue",
      number: issue.number,
      lastCommentId: talk.lastCommentId,
    })}`;

  return page({
    ctx,
    title: `${issue.title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
    styleCss: labelCss([...all, ...applied]),
    scriptJs: liveClientJs,
  });
}

// GET /:owner/:name/issues/:number/thread?after=<id>
export function issueThreadFragment(ctx: Ctx): Response {
  return threadFragment(ctx, "issue");
}

// POST /:owner/:name/issues/:number/comments
export async function issueCommentSubmit(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const dest = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  const body = field(form, "body");
  if (body.trim() === "")
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "A comment needs something in it.",
    });
  const added = addComment(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    body,
  );
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "That comment could not be posted.",
    });
  return flashTo(ctx, `${dest}#conversation`, { message: "Comment posted." });
}

export { parseNumber };
export type { Issue };
