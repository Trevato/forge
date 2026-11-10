/**
 * Browsing a repository that is not here yet.
 *
 * Pressing enter on a repository in the picker used to clone it, import every
 * issue, and take seconds doing it with nothing on screen. It opens it *live*
 * now: the same pages, rendered from the same `RepoSource`, read straight off
 * the origin's API through the view cache. Nothing is created, nothing is
 * written, and the header says so on every page.
 *
 * Three rules hold this file together.
 *
 * - **Read-only is structural, not polite.** These pages never render a
 *   composer, a state form, a label form, a merge box or a settings tab —
 *   because `RepoSource` has no mutation on it at all, there is nothing for
 *   them to submit to. The one thing you can do from here is start a mirror.
 * - **A browse spends the origin owner's credential**, so only that owner may
 *   open one, and only with the account itself (a session, the password, or an
 *   explicit admin token) — exactly the floor `/settings/origins` sits on. An
 *   origin somebody else connected is `not_found`, like everything else you
 *   cannot see.
 * - **The templates are the local ones** wherever a repository we hold has
 *   the same screen: the code, the commits, the branches. The issue and pull
 *   lists are the exception, kept below: a list here has no crew, no runs
 *   and no production to put a word to, so it reads the origin's own state,
 *   labels and authors instead.
 */

import { mirrorJobFor, startMirrorJob } from "../../actions/origins.ts";
import { forkOrigin } from "../../actions/contribute.ts";
import { getOriginFor } from "../../core/origins.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { isSafeOid, isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import type { MirrorJob, MirrorStage } from "../../origins/jobs.ts";
import type { IssueState, Label } from "../../core/issues.ts";
import type {
  CommentView,
  IssueDetail,
  IssueQuery,
  IssueSummary,
} from "../../view/source.ts";
import { sourceFor } from "../../view/source.ts";
import { notFoundPage, scopeHeader } from "../chrome.ts";
import { commentCard } from "../comments.ts";
import { renderDiff } from "../diff-view.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { TOO_LARGE_TO_EDIT } from "../edit_words.ts";
import { flashTo, fragment, page, redirect } from "../layout.ts";
import { codeJs, mirrorJs } from "../client.ts";
import { json, notFound } from "../../http/respond.ts";
import {
  browseBase,
  hostOf,
  liveBanner,
  originScope,
  type RepoScope,
} from "../scope.ts";
import {
  badge,
  btn,
  card,
  empty,
  icon,
  labelChip,
  labelCss,
  listCard,
  originTag,
  pager,
  row,
  seg,
  stateBadge,
  time,
  tlComment,
  userTag,
  type IconName,
} from "../ui.ts";
import { browseCommit, browseCommits } from "./commits.ts";
import { blankDraft, editorPage, runContribute } from "./edit.ts";
import { renderBranches } from "./branches.ts";
import {
  codeMount,
  explorerColumn,
  explorerFragment,
  finderDialog,
  loadExplorer,
} from "./explorer.ts";
import { accountOnly, hostLabel, originIcon } from "./origins.ts";
import { refSetFrom } from "./refs.ts";
import { stageRow, stageStateFor } from "../stage-row.ts";
import {
  blobView,
  codePage,
  renderBlob,
  renderCode,
  rawResponse,
} from "./repo.ts";

const PER_PAGE = 25;

// ---- the list's facets and rows ----

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
  counts: { open: number; closed: number } | undefined,
): Html {
  return html`<div class="bar mb">
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
      <form class="bar" method="get" action="${base}" role="search">
        ${when(query.state !== "open", () => hidden("state", query.state))}
        ${when(query.label !== "", () => hidden("label", query.label))}
        ${when(query.author !== "", () => hidden("author", query.author))}
        <input
          class="input"
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
function threadRow(
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
function summaryRow(
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
function scopeGlyph(scope: RepoScope): IconName {
  return scope.origin?.kind ?? scope.repo?.origin?.kind ?? "globe";
}

/** A `ListQuery` as the source's own query shape. */
function sourceQuery(
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

// ---- resolving one ----

/**
 * The scope for `/origins/:id/r/:owner/:name`, or the refusal.
 *
 * Every door into a live browse is this function, so there is one place to
 * get the access check right. `sourceFor` refuses an origin that is not this
 * user's; `accountOnly` refuses a leaked `ro`/`rw` token, which must not be
 * able to spend somebody's GitHub credential just because it can read a repo.
 */
async function browseScope(ctx: Ctx): Promise<RepoScope | Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const originId = ctx.params.id ?? "";
  const fullName = `${ctx.params.owner ?? ""}/${ctx.params.name ?? ""}`;
  const origin = getOriginFor(ctx.app.db, ctx.auth.user!.id, originId);
  if (origin === undefined) return notFoundPage(ctx);
  const source = sourceFor(ctx.app, ctx.auth.user, { originId, fullName });
  if (!source.ok) return notFoundPage(ctx);
  const reading = performance.now();
  const scope = await originScope(origin, source.value);
  notePhase(ctx.request, "repo", performance.now() - reading);
  if (scope === undefined) return unreachablePage(ctx, origin.webUrl);
  return scope;
}

/** The origin answered with something other than a repository. */
function unreachablePage(ctx: Ctx, webUrl: string): Response {
  return page(
    {
      ctx,
      title: "Not reachable",
      body: html`<div class="page-head"><h1>Nothing to read</h1></div>
        ${empty({
          icon: "alert",
          title: `${hostOf(webUrl)} did not answer for that repository`,
          note: "It may be gone, private to somebody else, or the origin may need re-authorizing. Nothing was changed here.",
          action: btn("Back to the repositories", {
            href: "/settings/origins",
            variant: "primary",
          }),
        })}`,
    },
    404,
  );
}

/** The ref a code page is looking at, defaulted and checked. */
function refOf(ctx: Ctx, scope: RepoScope): string {
  const wanted = ctx.params.ref ?? ctx.url.searchParams.get("ref") ?? "";
  return wanted !== "" && isSafeRef(wanted)
    ? wanted
    : scope.facts.defaultBranch;
}

const titleFor = (scope: RepoScope, lead?: string): string =>
  lead === undefined ? scope.fullName : `${lead} · ${scope.facts.name}`;

/** Every browse page: the header, the banner, then the page's own body. */
function browsePage(
  ctx: Ctx,
  scope: RepoScope,
  o: {
    title: string;
    header: Html;
    body: Html;
    styleCss?: string;
    scriptJs?: string;
  },
): Response {
  return page({
    ctx,
    title: o.title,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${o.header}${liveBanner(scope)} ${o.body}`,
    ...(o.styleCss === undefined ? {} : { styleCss: o.styleCss }),
    ...(o.scriptJs === undefined ? {} : { scriptJs: o.scriptJs }),
  });
}

// ---- code ----

// GET /origins/:id/r/:owner/:name
export async function browseHome(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const ref = refOf(ctx, scope);
  const reading = performance.now();
  const [refs, entries] = await Promise.all([
    refSetFrom(scope.source).then((r) => {
      notePhase(ctx.request, "refs", performance.now() - reading);
      return r;
    }),
    scope.source.tree(ref, "").then((r) => {
      notePhase(ctx.request, "tree", performance.now() - reading);
      return r;
    }),
  ]);
  const rendering = performance.now();
  const body = await renderCode(scope, {
    refs,
    ref,
    path: "",
    entries: entries.ok ? entries.value : [],
    rail: aboutRail(scope),
  });
  const response = browsePage(ctx, scope, {
    title: titleFor(scope),
    header: scopeHeader(ctx, scope, "code", {
      branchCount: refs.branches.length,
    }),
    body: html`${body}${codeMount(scope, ref)}${finderDialog()}`,
    scriptJs: codeJs,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /origins/:id/r/:owner/:name/paths/:ref
export async function browsePaths(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return notFound();
  const ref = refOf(ctx, scope);
  const reading = performance.now();
  const listed = await scope.source.paths(ref);
  notePhase(ctx.request, "paths", performance.now() - reading);
  if (!listed.ok) return notFound();
  const rendering = performance.now();
  const response = json(
    { ref, paths: listed.value.paths, truncated: listed.value.truncated },
    200,
    { "cache-control": "private, max-age=30" },
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// GET /origins/:id/r/:owner/:name/branches
export async function browseBranchesPage(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  return renderBranches(ctx, scope, liveBanner(scope));
}

// GET /origins/:id/r/:owner/:name/tree/:ref[/*path]
export async function browseTree(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const ref = refOf(ctx, scope);
  const path = ctx.params.path ?? "";
  if (path !== "" && !isSafeTreePath(path)) return notFoundPage(ctx);
  const entries = await scope.source.tree(ref, path);
  if (!entries.ok) return notFoundPage(ctx);

  if (ctx.url.searchParams.get("fragment") === "explorer")
    return fragment(explorerFragment(scope.base, ref, path, entries.value), {
      request: ctx.request,
    });

  const [refs, explorer] = await Promise.all([
    refSetFrom(scope.source),
    loadExplorer(scope.source, ref, path, false),
  ]);
  return codePage(ctx, scope, {
    title: titleFor(scope, path || ref),
    ref,
    before: liveBanner(scope),
    explorer: explorerColumn(scope, explorer, { finder: true }),
    content: await renderCode(scope, {
      refs,
      ref,
      path,
      entries: entries.value,
      all: ctx.url.searchParams.get("all") === "1",
    }),
  });
}

// GET /origins/:id/r/:owner/:name/blob/:ref/*path
export async function browseBlob(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const ref = refOf(ctx, scope);
  const path = ctx.params.path ?? "";
  if (!isSafeTreePath(path)) return notFoundPage(ctx);
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok) return notFoundPage(ctx);
  const refs = await refSetFrom(scope.source);
  const pane = renderBlob(scope, {
    refs,
    ref,
    path,
    blob: blob.value,
    view: blobView(ctx.url.searchParams.get("view")),
    all: ctx.url.searchParams.get("all") === "1",
  });
  if (ctx.url.searchParams.get("fragment") === "1")
    return fragment(pane, { request: ctx.request });

  const explorer = await loadExplorer(scope.source, ref, path, true);
  return codePage(ctx, scope, {
    title: titleFor(scope, path.split("/").pop() ?? path),
    ref,
    before: liveBanner(scope),
    explorer: explorerColumn(scope, explorer, { finder: true }),
    content: pane,
  });
}

// GET /origins/:id/r/:owner/:name/raw/:ref/*path
export async function browseRaw(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const ref = refOf(ctx, scope);
  const path = ctx.params.path ?? "";
  if (!isSafeTreePath(path)) return notFoundPage(ctx);
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok || blob.value.kind === "too_large") return notFoundPage(ctx);
  return rawResponse(blob.value);
}

// GET /origins/:id/r/:owner/:name/commits
export async function browseCommitsPage(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  return browseCommits(ctx, scope, liveBanner(scope));
}

// GET /origins/:id/r/:owner/:name/commit/:oid
export async function browseCommitPage(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const rev = ctx.params.oid ?? "";
  if (!isSafeOid(rev) && !isSafeRef(rev)) return notFoundPage(ctx);
  return browseCommit(ctx, scope, liveBanner(scope));
}

/** What the About rail says when the repository is not here. */
function aboutRail(scope: RepoScope): Html {
  const facts = scope.facts;
  const origin = scope.origin;
  return html`${card(
      html`${when(
          facts.description !== "",
          () => html`<p class="mb">${facts.description}</p>`,
        )}
        <div class="where-block">
          <h3>Where it lives</h3>
          <ul class="list setting-list">
            ${row({
              title: "Origin",
              trail:
                scope.originUrl === ""
                  ? html`${scope.fullName}`
                  : html`<a href="${scope.originUrl}" rel="noreferrer noopener"
                      >${scope.fullName}</a
                    >`,
            })}
            ${row({
              title: "Last push",
              trail: html`${facts.pushedAt === null ? "unknown" : time(facts.pushedAt)}`,
            })}
            ${row({ title: "Visibility", trail: html`${facts.visibility}` })}
            ${row({
              title: "Default",
              trail: html`<span class="mono">${facts.defaultBranch}</span>`,
            })}
          </ul>
          <p class="mt small muted">
            Nothing is stored here yet. Mirror it and this becomes a repository
            you own — issues, pulls and comments come with it, and pushes go
            back through
            ${origin === undefined
              ? html`the origin`
              : html`<span class="mono">${hostLabel(origin.webUrl)}</span>`}
            first.
          </p>
          ${when(
            scope.mirror === undefined,
            () =>
              // Outline, not primary: the header already carries the one
              // accent-coloured action this page is allowed.
              html`<form method="post" action="${scope.base}/mirror" class="mt">
                ${btn("Mirror it", {
                  variant: "outline",
                  icon: "download",
                  size: "sm",
                })}
              </form>`,
          )}
        </div>`,
      { head: html`<h2>About</h2>` },
  )}`;
}

// ---- issues and pulls ----

// GET /origins/:id/r/:owner/:name/issues
export async function browseIssues(ctx: Ctx): Promise<Response> {
  return browseThreadList(ctx, "issue");
}

// GET /origins/:id/r/:owner/:name/pulls
export async function browsePulls(ctx: Ctx): Promise<Response> {
  return browseThreadList(ctx, "pull");
}

async function browseThreadList(
  ctx: Ctx,
  kind: "issue" | "pull",
): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const segment = kind === "issue" ? "issues" : "pulls";
  const base = `${scope.base}/${segment}`;
  const query = readQuery(ctx);
  const [listed, labels] = await Promise.all([
    scope.source.issues(sourceQuery(query, kind, PER_PAGE)),
    scope.source.labels(),
  ]);
  const items = listed.ok ? listed.value.items : [];
  const next = listed.ok ? listed.value.next : null;
  const glyph = scopeGlyph(scope);
  const all = labels.ok ? labels.value : [];

  const list =
    items.length === 0
      ? empty({
          icon: kind === "issue" ? "issue" : "pull",
          title:
            query.state === "closed"
              ? `No closed ${segment}`
              : query.state === "all"
                ? `No ${segment} yet`
                : `No open ${segment}`,
          note: `Whatever is open on ${
            scope.origin === undefined
              ? "the origin"
              : hostLabel(scope.origin.webUrl)
          } shows up here — this is its list, read live.`,
        })
      : listCard(
          items.map((item) =>
            summaryRow(base, segment, item, glyph, item.state),
          ),
        );

  // The two counts a seg control usually carries need a search per state on
  // both providers, so a live list shows the filter without them rather than
  // paying two more round trips to decorate it.
  const body = html`<div class="mt">
    ${filterBar(base, query, all, undefined)} ${list}
    ${pager(
      next === null ? {} : { next: withFacet(base, query, {}, Number(next)) },
    )}
  </div>`;
  return browsePage(ctx, scope, {
    title: `${kind === "issue" ? "Issues" : "Pull requests"} · ${scope.facts.name}`,
    header: scopeHeader(ctx, scope, segment),
    body,
    styleCss: labelCss([...all, ...items.flatMap((i) => i.labels)]),
  });
}

// GET /origins/:id/r/:owner/:name/issues/:number
export async function browseIssue(ctx: Ctx): Promise<Response> {
  return browseThread(ctx, "issue");
}

// GET /origins/:id/r/:owner/:name/pulls/:number
export async function browsePull(ctx: Ctx): Promise<Response> {
  return browseThread(ctx, "pull");
}

async function browseThread(
  ctx: Ctx,
  kind: "issue" | "pull",
): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const number = Number(ctx.params.number);
  if (!Number.isInteger(number) || number < 1) return notFoundPage(ctx);
  const found = await scope.source.issue(number);
  if (!found.ok) return notFoundPage(ctx);
  const detail = found.value;
  if (detail.issue.kind !== kind) return notFoundPage(ctx);
  const segment = kind === "issue" ? "issues" : "pulls";
  const glyph = scopeGlyph(scope);

  const state: "open" | "closed" | "merged" =
    detail.pull?.mergedAt != null ? "merged" : detail.issue.state;

  const body = html`<div class="page-head">
      <h1>
        ${detail.issue.title}
        <span class="num">#${detail.issue.number}</span>
      </h1>
      <div class="page-head-sub bar muted small">
        ${stateBadge(state)}
        <span
          >${detail.issue.originAuthor ?? detail.issue.authorName} opened this
          ${time(detail.issue.createdAt)}</span
        >
        ${when(
          detail.issue.originUrl,
          (url) =>
            html`<a class="bar muted small" href="${url}" rel="noreferrer noopener"
              >${icon("external")}view on origin</a
            >`,
        )}
        ${when(
          detail.pull,
          (pull) =>
            html`<span class="mono"
              >${pull.headBranch} → ${pull.baseBranch}</span
            >`,
        )}
      </div>
    </div>
    ${when(detail.pull, () => mergeElsewhere(scope))}
    <div class="split">
      <div>${timelineOf(detail, glyph)}</div>
      <aside>
        ${card(
          detail.issue.labels.length === 0
            ? html`<p class="muted small">No labels.</p>`
            : html`<div class="bar">
                ${detail.issue.labels.map((l) => labelChip(l))}
              </div>`,
          { head: html`<h2>Labels</h2>` },
        )}
      </aside>
    </div>
    ${when(
      detail.pull?.diff,
      (diff) =>
        html`<h2 class="mt" id="files">Files changed</h2>
          ${renderDiff(diff)}`,
    )}`;

  return browsePage(ctx, scope, {
    title: `${detail.issue.title} · ${scope.facts.name}`,
    header: scopeHeader(ctx, scope, segment, {
      compact: true,
      ownTitle: true,
    }),
    body,
    styleCss: labelCss(detail.issue.labels),
  });
}

/** The opening post and every comment, in the order they were written. */
function timelineOf(
  detail: IssueDetail,
  glyph: Parameters<typeof icon>[0],
): Html {
  const opening = commentCard({
    id: "",
    author: detail.issue.authorName,
    at: detail.issue.createdAt,
    body: detail.body,
    verb: "opened this",
    originAuthor: detail.issue.originAuthor,
    originKind: glyph,
    originUrl: detail.issue.originUrl,
  });
  return html`<div class="timeline" id="conversation">
    ${tlComment(opening)}
    ${detail.comments.map((c: CommentView) =>
      tlComment(
        commentCard({
          id: c.id,
          author: c.authorName,
          at: c.createdAt,
          body: c.body,
          verb: "commented",
          originAuthor: c.originAuthor,
          originKind: glyph,
          originUrl: c.originUrl,
        }),
      ),
    )}
  </div>`;
}

/** A live pull is merged where it lives, and this says where that is. */
function mergeElsewhere(scope: RepoScope): Html {
  const host =
    scope.origin === undefined ? "the origin" : hostLabel(scope.origin.webUrl);
  // One §5 row in a toned card: `.setting-list` lets the sentence wrap and
  // drops the button under it on a phone.
  return card(
    html`<ul class="list setting-list">
      ${row({
        lead: icon(scope.origin ? originIcon(scope.origin.kind) : "globe"),
        title: `Merge on ${host}.`,
        meta: html`You are reading this pull request live. Merging, reviewing
          and commenting all happen where it lives — mirror the repository and
          comments come back through this forge instead.`,
        trail: when(scope.originUrl !== "", () =>
          // Outline: the header's Mirror button is this page's one accent.
          btn("Open on the origin", {
            href: scope.originUrl,
            variant: "outline",
            icon: "external",
            external: true,
          }),
        ),
      })}
    </ul>`,
    { tone: "attn", pad: false, extra: "mt" },
  );
}

// ---- starting a mirror ----

/**
 * POST /origins/:id/r/:owner/:name/mirror — the one thing a browse can do.
 *
 * It answers with the job page rather than the repository: mirroring is a
 * process with stages, and a 303 to a page that watches it is the difference
 * between "the browser hung for nine seconds" and "I can see what it is
 * doing". Starting a mirror that is already running lands on the same page —
 * `startMirrorJob` joins the running job rather than racing it.
 */
export async function browseMirrorSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const originId = ctx.params.id ?? "";
  const fullName = `${ctx.params.owner ?? ""}/${ctx.params.name ?? ""}`;
  const started = startMirrorJob(ctx.app, ctx.auth.user, originId, fullName);
  if (!started.ok)
    return flashTo(ctx, browseBase(originId, fullName), {
      tone: "danger",
      message: "That repository could not be mirrored.",
    });
  return redirect(`/settings/origins/${originId}/mirror/${started.value.id}`);
}

// ---- proposing a change to something you are only browsing ----

/**
 * GET /origins/:id/r/:owner/:name/edit/:ref/*path — the editor, live.
 *
 * The same editor as everywhere else, because it is the same file and the
 * same textarea. What differs is where the text goes: there is nothing local
 * to commit to, so the commit form is the propose card and the submit button
 * opens a pull request on somebody else's forge.
 */
export async function browseEditPage(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const propose = scope.propose;
  if (propose === undefined) return notFoundPage(ctx);
  const ref = refOf(ctx, scope);
  const path = ctx.params.path ?? "";
  if (!isSafeTreePath(path)) return notFoundPage(ctx);
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok) return notFoundPage(ctx);
  if (blob.value.kind !== "text")
    return flashTo(
      ctx,
      `${scope.base}/blob/${encodeURIComponent(ref)}/${path}`,
      {
        tone: "danger",
        message:
          blob.value.kind === "binary"
            ? "That file is binary — propose it with git, not a textarea."
            : TOO_LARGE_TO_EDIT,
      },
    );
  return editorPage(
    ctx,
    scope,
    await blankDraft(ctx, scope, ref, {
      path,
      content: new TextDecoder().decode(blob.value.body),
      creating: false,
    }),
  );
}

// GET /origins/:id/r/:owner/:name/new/:ref[/*path]
export async function browseNewFilePage(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  if (scope.propose === undefined) return notFoundPage(ctx);
  const ref = refOf(ctx, scope);
  const dir = ctx.params.path ?? "";
  if (dir !== "" && !isSafeTreePath(dir)) return notFoundPage(ctx);
  return editorPage(
    ctx,
    scope,
    await blankDraft(ctx, scope, ref, {
      path: dir === "" ? "" : `${dir}/`,
      content: "",
      creating: true,
    }),
  );
}

/**
 * POST /origins/:id/r/:owner/:name/contribute — fork, branch, commit, propose.
 *
 * `admin` is the floor, as it is for every other mutation reachable from a
 * live browse: the write travels under the *origin owner's* credential, and
 * a leaked read/write token must not be able to spend it.
 */
export async function browseContributeSubmit(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return scope;
  const propose = scope.propose;
  if (propose === undefined) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return runContribute(ctx, scope, propose, form);
}

// ---- forking, at the origin ----

/** Why a fork did not happen, in words a person can act on. */
export function forkFailure(error: string): string {
  if (error === "fork_timeout")
    return "The origin took the request and the fork has not appeared yet. Give it a moment and try again.";
  if (error === "origin_unreachable")
    return "The origin could not be reached. Nothing was created.";
  if (error === "origin_refused")
    return "The origin refused to fork that repository.";
  if (error === "origin_read_only")
    return "This account was connected read-only, so nothing is written through it.";
  if (error === "origin_paused")
    return "This connection is not verified yet, so writes through it are paused. Check it again under Settings → Origins.";
  if (error === "mirror_failed")
    return "The fork was made, but a local copy of it could not be.";
  if (error === "unauthorized") return "Sign in first.";
  return "That repository could not be forked.";
}

/**
 * POST /origins/:id/r/:owner/:name/fork — grab their repo.
 *
 * The fork is made at the origin, because that is where the repository
 * lives; the local copy of it is a mirror, and a mirror is a job with
 * stages. So this answers exactly as the Mirror button does — a 303 to the
 * page that watches the job — and the flash says what was created and where.
 * A fork that already existed skips the job and lands straight on it.
 */
export async function browseForkSubmit(ctx: Ctx): Promise<Response> {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const originId = ctx.params.id ?? "";
  const fullName = `${ctx.params.owner ?? ""}/${ctx.params.name ?? ""}`;
  const here = browseBase(originId, fullName);

  const origin = getOriginFor(ctx.app.db, ctx.auth.user!.id, originId);
  const forked = await forkOrigin(ctx.app, ctx.auth.user, originId, fullName);
  if (!forked.ok)
    return flashTo(ctx, here, {
      tone: "danger",
      message: forkFailure(forked.error),
    });

  const at = origin === undefined ? "the origin" : hostOf(origin.webUrl);
  const message = forked.value.existed
    ? `You already had ${forked.value.remote.fullName} at ${at} — that is the fork of ${fullName}.`
    : `Forked ${fullName} to ${forked.value.remote.fullName} at ${at}.`;
  const mirror = forked.value.mirror;
  if (mirror !== undefined)
    return flashTo(ctx, `/${mirror.ownerName}/${mirror.name}`, { message });
  const job = forked.value.job;
  if (job === undefined) return flashTo(ctx, here, { message });
  return flashTo(ctx, `/settings/origins/${originId}/mirror/${job.id}`, {
    message,
  });
}

// ---- the job page ----

const STAGES: { name: MirrorStage; label: string }[] = [
  { name: "creating", label: "Creating the repository" },
  { name: "fetching", label: "Fetching every branch and tag" },
  { name: "labels", label: "Importing labels" },
  { name: "issues", label: "Importing issues" },
  { name: "pulls", label: "Importing pull requests" },
  { name: "comments", label: "Importing comments" },
  { name: "done", label: "Done" },
];

const ORDER = STAGES.map((s) => s.name);

/** The checklist. Its shape is what `mirrorJs` updates in place. */
export function stageList(job: MirrorJob, streamUrl: string, landing = ""): Html {
  return html`<ol
    class="list stages"
    aria-live="polite"
    id="stages"
    data-stream="${streamUrl}"
    data-stage="${job.stage}"
    ${landing === "" ? null : html`data-landing="${landing}"`}
    data-repo="${job.repo === undefined
      ? ""
      : `/${job.repo.ownerName}/${job.repo.name}`}"
  >
    ${STAGES.map((stage) => {
      const state = stageStateFor(ORDER, stage.name, job.stage, job.failedAt);
      return stageRow({
        name: stage.name,
        label: stage.label,
        state,
        detail: job.detail,
      });
    })}
  </ol>`;
}

/**
 * GET /settings/origins/:id/mirror/:job — a mirror, while it happens.
 *
 * With JavaScript it subscribes to the job's own event stream, the checklist
 * moves without a reload, and it goes to the mirror when the job is done.
 * Without, the same markup says to Reload; there is no meta refresh.
 */
export function mirrorJobPage(ctx: Ctx): Response {
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const originId = ctx.params.id ?? "";
  const found = mirrorJobFor(
    ctx.app,
    ctx.auth.user,
    originId,
    ctx.params.job ?? "",
  );
  if (!found.ok) return notFoundPage(ctx);
  const job = found.value;
  const running = job.stage !== "done" && job.stage !== "failed";
  const mirror =
    job.repo === undefined
      ? undefined
      : `/${job.repo.ownerName}/${job.repo.name}`;
  const stream = `/api/v1/user/origins/${originId}/mirror/${job.id}/stream`;

  const foot =
    job.stage === "failed"
      ? html`<div class="toast" data-tone="danger" role="alert">
            ${icon("alert")}
            <div class="toast-body">${job.error ?? "The mirror failed."}</div>
          </div>
          <div class="bar mt">
            <form
              method="post"
              action="${browseBase(originId, job.fullName)}/mirror"
            >
              ${btn("Retry", { variant: "primary", icon: "sync" })}
            </form>
            ${btn("Back to the repository", {
              href: browseBase(originId, job.fullName),
              variant: "outline",
            })}
          </div>`
      : mirror !== undefined
        ? html`<div class="bar mt">
            ${btn("Open the mirror", {
              href: mirror,
              variant: "primary",
              icon: "repo",
            })}
            ${btn("Back to the repositories", {
              href: `/settings/origins/${originId}/repos`,
              variant: "ghost",
            })}
          </div>`
        : html`<p class="muted small mt">
            This keeps going if you close the page — come back to this link and
            it will say where it got to.
            <noscript>
              Without JavaScript this page does not move by itself:
              <a href="${ctx.url.pathname}">Reload</a> to see where it is.
            </noscript>
          </p>`;

  // Only a job still going streams: a finished one is a page that stands, a
  // failed one a page with the reason and a way to retry. No page here
  // refreshes itself; the script follows the stream and goes to the mirror.
  return page({
    ctx,
    title: `Mirroring ${job.fullName}`,
    body: html`<div class="page-head">
        <h1>Mirroring ${job.fullName}</h1>
        <span class="spacer"></span>
        ${badge(
          job.stage === "failed"
            ? "Failed"
            : job.stage === "done"
              ? "Done"
              : "Running",
          {
            tone:
              job.stage === "failed"
                ? "danger"
                : job.stage === "done"
                  ? "success"
                  : "attn",
          },
        )}
      </div>
      <div class="narrow-wide">
        ${card(stageList(job, running ? stream : ""), {
          head: html`${icon("download")}
            <h2>${job.fullName}</h2>`,
        })}
        ${foot}
      </div>`,
    scriptJs: mirrorJs,
  });
}
