/**
 * History: the commit list at any ref (optionally filtered to one path) and
 * one commit with its diff. The list is the cheapest page in the product —
 * one `git log` — so it stays a plain, dense, paged table of rows.
 *
 * The two renderers here take a `RepoScope`, not a repository, so the same
 * rows and the same commit page serve a repo we hold and one we are reading
 * live off another forge. What differs is only what the *handler* can ask
 * for: git can filter a log by path and page by offset; a provider's commit
 * list can do neither, so the live browse pages by cursor and says so.
 */

import { diffCommit, type Diff } from "../../git/diff.ts";
import { isSafeOid, isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import { commitLog } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import type { Commit } from "../../view/source.ts";
import { loadRepo, notFoundPage, scopeHeader } from "../chrome.ts";
import { diffSyntax } from "../diff-syntax.ts";
import { renderDiff, type SyntaxMap } from "../diff-view.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { localScope, type RepoScope } from "../scope.ts";
import {
  avatar,
  badge,
  card,
  empty,
  icon,
  listCard,
  originTag,
  pager,
  sha,
  time,
} from "../ui.ts";
import {
  pathCrumbs,
  refMenu,
  refSet,
  refSetFrom,
  type RefSet,
} from "./refs.ts";

const PER_PAGE = 30;

/** Infinity, 1e300 and NaN all collapse to page 1 — never a bogus skip. */
function pageNumber(raw: string | null): number {
  const requested = Math.floor(Number(raw));
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), 100_000)
    : 1;
}

// ---- shared renderers ----

/**
 * The commit rows. On a live browse the author is a login on the origin, so
 * it wears that forge's mark instead of a local avatar — the same rule every
 * imported author follows.
 */
export function commitRows(scope: RepoScope, commits: readonly Commit[]): Html {
  const glyph = scope.origin?.kind ?? scope.repo?.origin?.kind ?? "globe";
  return listCard(
    commits.map(
      (commit) =>
        html`<li>
          <a
            class="row"
            data-nav
            tabindex="-1"
            href="${scope.base}/commit/${commit.oid}"
          >
            <span class="row-lead"
              >${scope.kind === "origin" && commit.login
                ? icon(glyph)
                : avatar(commit.author)}</span
            >
            <span class="row-main">
              <span class="row-title" title="${commit.subject}"
                >${commit.subject}</span
              >
              <span class="row-meta"
                >${commit.author} committed
                ${time(commit.date)}${when(
                  commit.parents.length > 1,
                  () => html` · ${badge("merge", { variant: "secondary" })}`,
                )}</span
              >
            </span>
            <span class="row-trail">${sha(commit.oid)}</span>
          </a>
        </li>`,
    ),
  );
}

/** One commit's header card and its diff. */
export function renderCommit(
  scope: RepoScope,
  commit: Commit,
  diff: Diff,
  syntax: SyntaxMap,
): Html {
  const head: Html = card(
    html`<h2>${commit.subject}</h2>
      ${when(
        commit.body.trim() !== "",
        () => html`<pre class="commit-body">${commit.body}</pre>`,
      )}
      <div class="issue-meta">
        ${commit.login
          ? originTag(
              commit.login,
              scope.origin?.kind ?? scope.repo?.origin?.kind ?? "globe",
            )
          : avatar(commit.author)}
        <span>${commit.author} committed ${time(commit.date)}</span>
        ${sha(commit.oid)}
        ${when(
          commit.parents.length > 1,
          () => html`${badge("merge", { icon: "merge" })}`,
        )}
        <span class="spacer"></span>
        <a
          class="btn"
          data-size="sm"
          data-variant="outline"
          href="${scope.base}/tree/${commit.oid}"
          >${icon("repo")}Browse files</a
        >
      </div>`,
    { extra: "commit-head" },
  );
  return html`<div class="mt">${head}</div>
    <div class="mt">${renderDiff(diff, syntax)}</div>`;
}

/** The ref switcher (and path crumbs) above a history list. */
export function historyBar(
  scope: RepoScope,
  refs: RefSet,
  ref: string,
  path: string,
  hrefFor: (r: string) => string,
): Html {
  return html`<div class="bar mt mb">
    ${refMenu(refs, ref, hrefFor)}
    ${when(path !== "", () =>
      pathCrumbs(scope.base, scope.facts.name, ref, path, false),
    )}
  </div>`;
}

export const noCommits = (later: boolean): Html =>
  empty({
    icon: "commit",
    title: later ? "No commits on this page" : "No commits yet",
    note: later
      ? "You have paged past the end of this history."
      : "Push a branch and its history shows up here.",
  });

// ---- the local pages ----

// GET /:owner/:name/commits?ref=&path=&page=
export async function commitsPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const base = scope.base;

  const wantedRef = ctx.url.searchParams.get("ref");
  const ref =
    wantedRef !== null && isSafeRef(wantedRef) ? wantedRef : repo.defaultBranch;
  const wantedPath = ctx.url.searchParams.get("path");
  const path =
    wantedPath !== null && wantedPath !== "" && isSafeTreePath(wantedPath)
      ? wantedPath
      : "";

  const num = pageNumber(ctx.url.searchParams.get("page"));
  // Path filtering and offset paging are things git does and a provider API
  // does not, so the local page keeps its own log read rather than pretending
  // the shared source could answer this.
  const log = await commitLog(dir, ref, {
    limit: PER_PAGE + 1,
    skip: (num - 1) * PER_PAGE,
    ...(path !== "" ? { path } : {}),
  });
  const refs = await refSet(dir);

  const query = (n: number) => {
    const params = new URLSearchParams({ ref });
    if (path !== "") params.set("path", path);
    if (n > 1) params.set("page", String(n));
    return `${base}/commits?${params.toString()}`;
  };
  const switcher = historyBar(scope, refs, ref, path, (r) => {
    const params = new URLSearchParams({ ref: r });
    if (path !== "") params.set("path", path);
    return `${base}/commits?${params.toString()}`;
  });

  if (!log.ok || log.value.length === 0) {
    return page({
      ctx,
      title: `Commits · ${repo.name}`,
      crumbs: scope.crumbs,
      palette: scope.palette,
      body: html`${scopeHeader(ctx, scope, "commits")}${switcher}
      ${noCommits(num > 1)} ${liveMount({ repo: base })}`,
      scriptJs: liveClientJs,
    });
  }

  const commits = log.value.slice(0, PER_PAGE);
  const hasMore = log.value.length > PER_PAGE;

  const body = html`${scopeHeader(ctx, scope, "commits")}${switcher}
  ${commitRows(scope, commits)}
  ${pager({
    ...(num > 1 ? { prev: query(num - 1) } : {}),
    ...(hasMore ? { next: query(num + 1) } : {}),
    note: `Page ${num}`,
  })}
  ${liveMount({ repo: base })}`;
  return page({
    ctx,
    title: `Commits · ${repo.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
    scriptJs: liveClientJs,
  });
}

// GET /:owner/:name/commit/:oid — one commit's metadata and its diff.
export async function commitPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const rev = ctx.params.oid ?? "";
  if (!isSafeOid(rev) && !isSafeRef(rev)) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);

  const log = await commitLog(dir, rev, { limit: 1 });
  if (!log.ok || log.value.length === 0) return notFoundPage(ctx);
  const commit = log.value[0]!;

  const diffResult = await diffCommit(dir, commit.oid);
  const diff = diffResult.ok
    ? diffResult.value
    : { files: [], additions: 0, deletions: 0 };
  // Old side is the first parent (or the empty tree for a root commit, where
  // every file is an addition and no old blob is read).
  const parent = commit.parents[0] ?? commit.oid;
  const syntax = await diffSyntax(dir, diff, parent, commit.oid);

  const body = html`${scopeHeader(ctx, scope, "commits", { compact: true })}
  ${renderCommit(scope, commit, diff, syntax)}`;
  return page({
    ctx,
    title: `${commit.subject} · ${repo.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
}

// ---- the live-browse pages ----

/**
 * GET /origins/:id/r/:owner/:name/commits?ref=&cursor=
 *
 * `banner` is the live-browse note, passed in rather than spliced on: it
 * belongs between the tab row and the content, which is a place only the
 * page that assembles the body knows.
 */
export async function browseCommits(
  ctx: Ctx,
  scope: RepoScope,
  banner: Html,
): Promise<Response> {
  const base = scope.base;
  const wantedRef = ctx.url.searchParams.get("ref");
  const ref =
    wantedRef !== null && isSafeRef(wantedRef)
      ? wantedRef
      : scope.facts.defaultBranch;
  const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
  const [refs, listed] = await Promise.all([
    refSetFrom(scope.source),
    scope.source.commits(ref, cursor),
  ]);
  const switcher = historyBar(
    scope,
    refs,
    ref,
    "",
    (r) => `${base}/commits?ref=${encodeURIComponent(r)}`,
  );
  const commits = listed.ok ? listed.value.items : [];
  const next = listed.ok ? listed.value.next : null;
  const nextHref =
    next === null
      ? undefined
      : `${base}/commits?ref=${encodeURIComponent(ref)}&cursor=${encodeURIComponent(next)}`;

  const body = html`${scopeHeader(ctx, scope, "commits")}${banner}${switcher}
  ${commits.length === 0
    ? noCommits(cursor !== undefined)
    : html`${commitRows(scope, commits)}
      ${pager(nextHref === undefined ? {} : { next: nextHref })}`}`;
  return page({
    ctx,
    title: `Commits · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
}

/** GET /origins/:id/r/:owner/:name/commit/:oid */
export async function browseCommit(
  ctx: Ctx,
  scope: RepoScope,
  banner: Html,
): Promise<Response> {
  const rev = ctx.params.oid ?? "";
  const found = await scope.source.commit(rev);
  if (!found.ok) return notFoundPage(ctx);
  // No work tree and no blobs fetched: a live diff renders without syntax
  // colour rather than paying two blob round trips per file to get it.
  const body = html`${scopeHeader(ctx, scope, "commits", {
    compact: true,
  })}${banner}
  ${renderCommit(scope, found.value.commit, found.value.diff, new Map())}`;
  return page({
    ctx,
    title: `${found.value.commit.subject} · ${scope.facts.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
}
