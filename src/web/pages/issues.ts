/**
 * Issue pages: the list with its filters, one issue with its timeline, and
 * the compose form. Prose is markdown; every state change is a plain form
 * post to its own endpoint. Mobile-first, no JavaScript required.
 */

import { threadNote } from "../../crew/direct.ts";
import { addCommentThrough, openIssueThrough } from "../../actions/issues.ts";
import {
  issueCounts,
  labelsFor,
  listLabels,
  type Issue,
  type IssueState,
  type Label,
} from "../../core/issues.ts";
import { canRead, type Repo } from "../../core/repos.ts";
import { waitingCount } from "../../actions/reports.ts";
import type { Ctx } from "../../http/context.ts";
import type { IssueQuery, IssueSummary } from "../../view/source.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  scopeHeader,
  signInFirst,
  stickyAction,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { localScope, type RepoScope } from "../scope.ts";
import {
  btn,
  empty,
  icon,
  labelChip,
  labelCss,
  listCard,
  pager,
  seg,
  originTag,
  stateBadge,
  time,
  userLink,
  userTag,
  field as formField,
  type IconName,
} from "../ui.ts";
import {
  assigneeCard,
  dependenciesCard,
  composer,
  conversation,
  labelsCard,
  originError,
  originGlyph,
  parseNumber,
  threadContext,
  threadFragment,
} from "./thread.ts";
import { crewActivityCard, workSpent } from "./runs.ts";
import { studioTells } from "../studio/lists.ts";
import {
  PAGE_TITLES,
  pageTitle,
  studioRecord,
  tellsHref,
} from "../studio/nouns.ts";
import { studioTell } from "../studio/tell.ts";

const PER_PAGE = 25;

// ---- the list ----

export interface ListQuery {
  state: IssueState | "all";
  label: string;
  author: string;
  q: string;
  cursor: number | undefined;
}

export function readQuery(ctx: Ctx): ListQuery {
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
export function withFacet(
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

export function filterBar(
  base: string,
  query: ListQuery,
  labels: Label[],
  counts: { open: number; closed: number } | undefined,
): Html {
  return html`<div class="filters">
      ${seg([
        {
          label: "Open",
          href: withFacet(base, query, { state: "open" }),
          current: query.state === "open",
          ...(counts === undefined ? {} : { count: counts.open }),
        },
        {
          label: "Closed",
          href: withFacet(base, query, { state: "closed" }),
          current: query.state === "closed",
          ...(counts === undefined ? {} : { count: counts.closed }),
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
  issue: { number: number; title: string },
  labels: readonly Label[],
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

/**
 * One row from a `RepoSource` summary — the shape both sides speak. A live
 * browse and a repository we hold produce byte-identical rows; only the base
 * of the href differs.
 */
export function summaryRow(
  base: string,
  segment: "issues" | "pulls",
  item: IssueSummary,
  glyph: IconName,
  state: "open" | "closed" | "merged",
  extraMeta?: Html,
): Html {
  return threadRow(
    base,
    segment,
    item,
    item.labels,
    state,
    html`#${item.number}${extraMeta ?? null} opened ${time(item.createdAt)} by
    ${item.originAuthor
      ? originTag(item.originAuthor, glyph)
      : userTag(item.authorName)}`,
    item.commentCount,
  );
}

/** The mark an imported author wears on this scope. */
export function scopeGlyph(scope: RepoScope): IconName {
  return scope.origin?.kind ?? scope.repo?.origin?.kind ?? "globe";
}

/** A `ListQuery` as the source's own query shape. */
export function sourceQuery(
  query: ListQuery,
  kind: "issue" | "pull",
  limit: number,
): IssueQuery {
  return {
    kind,
    state: query.state,
    limit,
    ...(query.label !== "" ? { label: query.label } : {}),
    ...(query.author !== "" ? { author: query.author } : {}),
    ...(query.q !== "" ? { query: query.q } : {}),
    ...(query.cursor !== undefined ? { cursor: String(query.cursor) } : {}),
  };
}

// GET /:owner/:name/issues
export async function issuesList(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  // In the studio "everything told" is the issue list in the studio's own
  // words — the same rule `issuePage` follows for one tell. `?mode=dev` is
  // the one-off way to dev's list without switching the browser.
  const record = studioRecord(ctx, repo);
  if (record !== undefined) return await studioTells(ctx, repo, record);
  const scope = localScope(ctx, repo);
  const base = scope.base;
  const query = readQuery(ctx);
  const db = ctx.app.db;

  const listed = await scope.source.issues(
    sourceQuery(query, "issue", PER_PAGE),
  );
  const issues = listed.ok ? listed.value.items : [];
  const nextCursor = listed.ok ? listed.value.next : null;
  const repoLabels = listLabels(db, repo.id);
  const glyph = scopeGlyph(scope);
  // One grouped read for both numbers the seg control above the list shows.
  const counts = issueCounts(db, repo.id, "issue");

  const newIssue = ctx.auth.user
    ? btn("New issue", {
        href: `${base}/issues/new`,
        variant: "primary",
        icon: "plus",
        shortcut: "c",
      })
    : btn("Sign in to open an issue", { href: "/signin" });
  // A stranger can still say something is wrong on a public repository;
  // its writers see how many such reports wait for them.
  const outside = canRead(db, repo, undefined)
    ? btn("Report a problem", { href: `${base}/report`, variant: "ghost" })
    : null;
  const waiting = waitingCount(ctx.app, ctx.auth.user, repo);
  const reports =
    waiting > 0
      ? btn(`${waiting} from outside`, { href: `${base}/reports` })
      : null;

  const list =
    issues.length === 0
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
          issues.map((issue) =>
            summaryRow(base, "issues", issue, glyph, issue.state),
          ),
        );

  const body = html`${scopeHeader(ctx, scope, "issues")}
    <div class="mt">
      ${when(
        ctx.auth.user === undefined || reports !== null,
        () => html`<div class="form-actions">${reports} ${ctx.auth.user === undefined ? outside : null}</div>`,
      )}
      ${filterBar(`${base}/issues`, query, repoLabels, counts)} ${list}
      ${pager(
        nextCursor === null
          ? {}
          : {
              next: withFacet(`${base}/issues`, query, {}, Number(nextCursor)),
            },
      )}
    </div>
    ${when(ctx.auth.user !== undefined, () => stickyAction(newIssue))}
    ${liveMount({ repo: base })}`;

  return page({
    ctx,
    title: pageTitle("tells", repo, false),
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
    styleCss: labelCss([...repoLabels, ...issues.flatMap((i) => i.labels)]),
    scriptJs: liveClientJs,
  });
}

// ---- compose ----

/**
 * The compose page, in the face the viewer has: the studio's own noun for
 * it (`PAGE_TITLES.compose`) on the tab, the heading and the button, and
 * Cancel back to the list that face calls home. The form posts to
 * `/issues/new` in both faces — the one door that changes something.
 */
function composePage(
  ctx: Ctx,
  repo: Repo,
  values: { title: string; body: string },
  error?: string,
): Response {
  const studio = studioRecord(ctx, repo) !== undefined;
  const heading = PAGE_TITLES.compose[studio ? "studio" : "dev"];
  const base = repoBase(repo);
  return page(
    {
      ctx,
      title: pageTitle("compose", repo, studio),
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body: html`${repoHeader(ctx, repo, "issues", {
          compact: true,
          ownTitle: true,
        })}
        <h1 class="mt">${heading}</h1>
        ${newIssueForm(
          repo,
          values,
          studio ? "Tell" : "Create issue",
          studio ? tellsHref(base) : `${base}/issues`,
          error,
        )}`,
    },
    error === undefined ? 200 : 422,
  );
}

function newIssueForm(
  repo: Repo,
  values: { title: string; body: string },
  submit: string,
  cancelHref: string,
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
        ${btn(submit, { variant: "primary", icon: "issue" })}
        ${btn("Cancel", { href: cancelHref, variant: "ghost" })}
      </div>
    </form>
  </div>`;
}

// GET /:owner/:name/issues/new
export function newIssuePage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  return composePage(ctx, repo, { title: "", body: "" });
}

// GET /:owner/:name/tells/new — the studio's own door onto the compose page
// `/issues/new` reaches, redirecting there when the studio does not apply,
// the same rule `tellPage` follows for one tell.
export function newTellPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (studioRecord(ctx, repo) === undefined)
    return redirect(`${repoBase(repo)}/issues/new${ctx.url.search}`);
  return newIssuePage(ctx);
}

// POST /:owner/:name/issues/new
export async function newIssueSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const values = { title: field(form, "title"), body: field(form, "body") };
  // The `…Through` twin: on a mirror the origin creates the issue, so the
  // number and the timestamps are the origin's rather than ones we invented.
  const created = await openIssueThrough(ctx.app, ctx.auth.user, repo, values);
  if (!created.ok) {
    // Nothing typed is ever lost: the form comes back exactly as it was sent.
    const message =
      originError(created.error) ??
      (created.error === "empty_title"
        ? "An issue needs a title."
        : created.error === "title_too_long"
          ? "That title is too long (256 characters at most)."
          : created.error === "body_too_long"
            ? "That description is too long (64 KB at most)."
            : "You cannot open an issue here.");
    return composePage(ctx, repo, values, message);
  }
  return flashTo(ctx, `${repoBase(repo)}/issues/${created.value.number}`, {
    message: `Issue #${created.value.number} opened.`,
  });
}

// ---- one issue ----

// GET /:owner/:name/issues/:number
export async function issuePage(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  const { repo, issue } = found;
  // In the studio a tell is one sentence someone said, not dev's labels and
  // dependency form — the same rule `pullPage` follows for a change, and the
  // same rule `tellPage` below asks before opening this very page under the
  // studio's own noun. `?mode=dev` on the URL is the escape hatch to dev's
  // page, resolved once for `ctx.mode`.
  if (studioRecord(ctx, repo) !== undefined)
    return await studioTell(ctx, repo, issue);
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
          >${issue.originAuthor
            ? originTag(issue.originAuthor, originGlyph(repo))
            : userLink(issue.authorName)}
          opened this ${time(issue.createdAt)}</span
        >
        ${when(
          issue.originUrl,
          (url) =>
            html`<a class="origin-link" href="${url}" rel="noreferrer noopener"
              >${icon("external")}view on origin</a
            >`,
        )}
        ${workSpent(ctx, repo, issue.id)}
      </div>
    </div>
    <div class="split">
      <div>
        ${talk.node}
        ${composer(ctx, {
          action: `${thread}/comments`,
          stateAction: `${thread}/state`,
          state: issue.state,
          closeLabel: "Close issue",
          reasons: true,
          crewNote: threadNote(ctx.app.db, repo, issue),
        })}
      </div>
      <aside>
        ${assigneeCard(ctx, repo, issue, `${thread}/assignee`)}
        ${dependenciesCard(ctx, repo, issue, `${thread}/dependencies`)}
        ${labelsCard(ctx, repo, issue, applied, all, `${thread}/labels`)}
        ${crewActivityCard(ctx, repo, issue)}
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
    palette: repoPalette(ctx, repo),
    body,
    styleCss: labelCss([...all, ...applied]),
    scriptJs: liveClientJs,
  });
}

/**
 * GET /:owner/:name/tells/:number — the studio's own noun for the page
 * `/issues/:number` already reaches. The page is `studioTell`, rendered
 * from here exactly as `issuePage` renders it: one handler each, never a
 * second copy of the page, and the same `threadContext` for who may see it,
 * so a reader who may not gets the forge's not-found at either address.
 *
 * A viewer the studio's tell does not apply to — dev mode, `?mode=dev`, or
 * a repository that is not an app — is sent on to `/issues/:number`, dev's
 * own address, the same rule `tellsList` follows for the list. The other
 * direction never bounces: `/issues/:number` asked for in studio mode
 * answers the studio's page where it stands, so every link ever written to
 * it keeps working and no reader is redirected out of a URL they were
 * handed.
 */
export async function tellPage(ctx: Ctx): Promise<Response> {
  const found = threadContext(ctx, "issue");
  if (found instanceof Response) return found;
  const { repo, issue } = found;
  if (studioRecord(ctx, repo) === undefined)
    return redirect(
      `${repoBase(repo)}/issues/${issue.number}${ctx.url.search}`,
    );
  return await studioTell(ctx, repo, issue);
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

  // A comment posted from the board's "the planner declined" line returns to
  // the board. A fixed word, never a URL from the form: no open redirect.
  const back = field(form, "back") === "board" ? "/board" : undefined;
  const dest = `${repoBase(found.repo)}/issues/${found.issue.number}`;
  const body = field(form, "body");
  if (body.trim() === "")
    return flashTo(ctx, dest, {
      tone: "danger",
      message: "A comment needs something in it.",
    });
  const added = await addCommentThrough(
    ctx.app,
    ctx.auth.user,
    found.repo,
    found.issue,
    body,
  );
  if (!added.ok)
    return flashTo(ctx, dest, {
      tone: "danger",
      message: originError(added.error) ?? "That comment could not be posted.",
    });
  return back === undefined
    ? flashTo(ctx, `${dest}#conversation`, { message: "Comment posted." })
    : flashTo(ctx, back, {
        message: `Answered on #${found.issue.number}. The planner plans again.`,
      });
}

export { parseNumber };
export type { Issue };
