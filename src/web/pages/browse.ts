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
 * - **The templates are the local ones.** Every renderer here is imported
 *   from the page that serves the same screen for a repository we hold. A
 *   divergence between the two would be a bug you could see.
 */

import { mirrorJobFor, startMirrorJob } from "../../actions/origins.ts";
import { getOriginFor } from "../../core/origins.ts";
import { isSafeOid, isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import type { Ctx } from "../../http/context.ts";
import type { MirrorJob, MirrorStage } from "../../origins/jobs.ts";
import type { CommentView, IssueDetail } from "../../view/source.ts";
import { sourceFor } from "../../view/source.ts";
import { notFoundPage, scopeHeader } from "../chrome.ts";
import { commentCard } from "../comments.ts";
import { renderDiff } from "../diff-view.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
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
  pager,
  stateBadge,
  time,
  tlComment,
} from "../ui.ts";
import { browseCommit, browseCommits } from "./commits.ts";
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
import {
  blobView,
  codePage,
  renderBlob,
  renderCode,
  rawResponse,
} from "./repo.ts";
import {
  filterBar,
  readQuery,
  scopeGlyph,
  sourceQuery,
  summaryRow,
  withFacet,
} from "./issues.ts";

const PER_PAGE = 25;

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
  const denied = accountOnly(ctx);
  if (denied) return denied;
  const originId = ctx.params.id ?? "";
  const fullName = `${ctx.params.owner ?? ""}/${ctx.params.name ?? ""}`;
  const origin = getOriginFor(ctx.app.db, ctx.auth.user!.id, originId);
  if (origin === undefined) return notFoundPage(ctx);
  const source = sourceFor(ctx.app, ctx.auth.user, { originId, fullName });
  if (!source.ok) return notFoundPage(ctx);
  const scope = await originScope(origin, source.value);
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
  const [refs, entries] = await Promise.all([
    refSetFrom(scope.source),
    scope.source.tree(ref, ""),
  ]);
  const body = await renderCode(scope, {
    refs,
    ref,
    path: "",
    entries: entries.ok ? entries.value : [],
    rail: aboutRail(scope),
  });
  return browsePage(ctx, scope, {
    title: titleFor(scope),
    header: scopeHeader(ctx, scope, "code", {
      branchCount: refs.branches.length,
    }),
    body: html`${body}${codeMount(scope, ref)}${finderDialog()}`,
    scriptJs: codeJs,
  });
}

// GET /origins/:id/r/:owner/:name/paths/:ref
export async function browsePaths(ctx: Ctx): Promise<Response> {
  const scope = await browseScope(ctx);
  if (scope instanceof Response) return notFound();
  const ref = refOf(ctx, scope);
  const listed = await scope.source.paths(ref);
  if (!listed.ok) return notFound();
  return json(
    { ref, paths: listed.value.paths, truncated: listed.value.truncated },
    200,
    { "cache-control": "private, max-age=30" },
  );
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
    return fragment(explorerFragment(scope.base, ref, path, entries.value));

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
  });
  if (ctx.url.searchParams.get("fragment") === "1") return fragment(pane);

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
  return html`<aside class="about">
    ${card(
      html`${when(
          facts.description !== "",
          () => html`<p class="mb">${facts.description}</p>`,
        )}
        <div class="where-block">
          <h3>Where it lives</h3>
          <dl>
            <dt>Origin</dt>
            <dd>
              ${scope.originUrl === ""
                ? html`${scope.fullName}`
                : html`<a href="${scope.originUrl}" rel="noreferrer noopener"
                    >${scope.fullName}</a
                  >`}
            </dd>
            <dt>Last push</dt>
            <dd>
              ${facts.pushedAt === null ? "unknown" : time(facts.pushedAt)}
            </dd>
            <dt>Visibility</dt>
            <dd>${facts.visibility}</dd>
            <dt>Default</dt>
            <dd class="mono">${facts.defaultBranch}</dd>
          </dl>
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
    )}
  </aside>`;
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

  const body = html`<div class="issue-head">
      <h1>
        ${detail.issue.title}
        <span class="number">#${detail.issue.number}</span>
      </h1>
      <div class="issue-meta">
        ${stateBadge(state)}
        <span
          >${detail.issue.originAuthor ?? detail.issue.authorName} opened this
          ${time(detail.issue.createdAt)}</span
        >
        ${when(
          detail.issue.originUrl,
          (url) =>
            html`<a class="origin-link" href="${url}" rel="noreferrer noopener"
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
  return card(
    html`${icon(scope.origin ? originIcon(scope.origin.kind) : "globe")}
      <div class="grow">
        <div class="merge-headline">Merge on ${host}.</div>
        <p class="merge-sub">
          You are reading this pull request live. Merging, reviewing and
          commenting all happen where it lives — mirror the repository and
          comments come back through this forge instead.
        </p>
      </div>
      ${when(
        scope.originUrl !== "",
        () =>
          // Outline: the header's Mirror button is this page's one accent.
          html`<span class="merge-form"
            >${btn("Open on the origin", {
              href: scope.originUrl,
              variant: "outline",
              icon: "external",
              external: true,
            })}</span
          >`,
      )}`,
    { tone: "attn", extra: "merge-box" },
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

/** Where one row stands relative to where the job has got to. */
function stageState(
  stage: MirrorStage,
  at: MirrorStage,
): "done" | "now" | "todo" {
  // A failed job no longer remembers which stage it was on — `advance`
  // overwrites it — so nothing is claimed as done. The scrubbed error under
  // the list is the honest account, and a checklist that guessed would not be.
  if (at === "failed") return "todo";
  const here = ORDER.indexOf(stage);
  const there = ORDER.indexOf(at);
  if (here < there) return "done";
  if (here === there) return at === "done" ? "done" : "now";
  return "todo";
}

const GLYPH = { done: "●", now: "◐", todo: "○" } as const;

/** The checklist. Its shape is what `mirrorJs` updates in place. */
export function stageList(job: MirrorJob, streamUrl: string): Html {
  return html`<ol
    class="stages"
    id="stages"
    data-stream="${streamUrl}"
    data-stage="${job.stage}"
  >
    ${STAGES.map((stage) => {
      const state = stageState(stage.name, job.stage);
      return html`<li data-stage-name="${stage.name}" data-state="${state}">
        <span class="stage-dot" aria-hidden="true">${GLYPH[state]}</span>
        <span class="stage-label">${stage.label}</span>
        <span class="stage-detail">${state === "now" ? job.detail : ""}</span>
      </li>`;
    })}
  </ol>`;
}

/**
 * GET /settings/origins/:id/mirror/:job — a mirror, while it happens.
 *
 * With no JavaScript this is a page that refreshes itself every two seconds
 * and stops when the job stops. With JavaScript it subscribes to the job's
 * own event stream and the checklist moves without a reload. Both render the
 * same markup, and the page is correct if the script never arrives.
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
      ? html`<p class="error-note">${job.error ?? "The mirror failed."}</p>
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
            it will say where it got to. No JavaScript? This page refreshes
            itself every couple of seconds.
          </p>`;

  return page({
    ctx,
    title: `Mirroring ${job.fullName}`,
    ...(running
      ? { refresh: { seconds: 2 } }
      : mirror !== undefined
        ? { refresh: { seconds: 1, url: mirror } }
        : {}),
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
        ${card(stageList(job, stream), {
          head: html`${icon("download")}
            <h2>${job.fullName}</h2>`,
        })}
        ${foot}
      </div>`,
    scriptJs: mirrorJs,
  });
}
