/**
 * History: the commit list at any ref (optionally filtered to one path) and
 * one commit with its diff. The list is the cheapest page in the product —
 * one `git log` — so it stays a plain, dense, paged table of rows.
 */

import { diffCommit } from "../../git/diff.ts";
import { isSafeOid, isSafeRef, isSafeTreePath } from "../../git/guard.ts";
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
} from "../chrome.ts";
import { diffSyntax } from "../diff-syntax.ts";
import { renderDiff } from "../diff-view.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import {
  avatar,
  badge,
  card,
  empty,
  icon,
  listCard,
  pager,
  sha,
  time,
} from "../ui.ts";
import { pathCrumbs, refMenu, refSet } from "./refs.ts";

const PER_PAGE = 30;

/** Infinity, 1e300 and NaN all collapse to page 1 — never a bogus skip. */
function pageNumber(raw: string | null): number {
  const requested = Math.floor(Number(raw));
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), 100_000)
    : 1;
}

// GET /:owner/:name/commits?ref=&path=&page=
export async function commitsPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const base = repoBase(repo);

  const wantedRef = ctx.url.searchParams.get("ref");
  const ref =
    wantedRef !== null && isSafeRef(wantedRef) ? wantedRef : repo.defaultBranch;
  const wantedPath = ctx.url.searchParams.get("path");
  const path =
    wantedPath !== null && wantedPath !== "" && isSafeTreePath(wantedPath)
      ? wantedPath
      : "";

  const num = pageNumber(ctx.url.searchParams.get("page"));
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
  const switcher = html`<div class="bar mt mb">
    ${refMenu(refs, ref, (r) => {
      const params = new URLSearchParams({ ref: r });
      if (path !== "") params.set("path", path);
      return `${base}/commits?${params.toString()}`;
    })}
    ${when(path !== "", () => pathCrumbs(repo, ref, path, false))}
  </div>`;

  if (!log.ok || log.value.length === 0) {
    return page({
      ctx,
      title: `Commits · ${repo.name}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(repo),
      body: html`${repoHeader(ctx, repo, "commits")}${switcher}
      ${empty({
        icon: "commit",
        title: num > 1 ? "No commits on this page" : "No commits yet",
        note:
          num > 1
            ? "You have paged past the end of this history."
            : "Push a branch and its history shows up here.",
      })}`,
    });
  }

  const commits = log.value.slice(0, PER_PAGE);
  const hasMore = log.value.length > PER_PAGE;

  const rows = commits.map(
    (commit) =>
      html`<li>
        <a
          class="row"
          data-nav
          tabindex="-1"
          href="${base}/commit/${commit.oid}"
        >
          <span class="row-lead">${avatar(commit.author)}</span>
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
  );

  const body = html`${repoHeader(ctx, repo, "commits")}${switcher}
  ${listCard(rows)}
  ${pager({
    ...(num > 1 ? { prev: query(num - 1) } : {}),
    ...(hasMore ? { next: query(num + 1) } : {}),
    note: `Page ${num}`,
  })}`;
  return page({
    ctx,
    title: `Commits · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
  });
}

// GET /:owner/:name/commit/:oid — one commit's metadata and its diff.
export async function commitPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const rev = ctx.params.oid ?? "";
  if (!isSafeOid(rev) && !isSafeRef(rev)) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const base = repoBase(repo);

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

  const head: Html = card(
    html`<h2>${commit.subject}</h2>
      ${when(
        commit.body.trim() !== "",
        () => html`<pre class="commit-body">${commit.body}</pre>`,
      )}
      <div class="issue-meta">
        ${avatar(commit.author)}
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
          href="${base}/tree/${commit.oid}"
          >${icon("repo")}Browse files</a
        >
      </div>`,
    { extra: "commit-head" },
  );

  const body = html`${repoHeader(ctx, repo, "commits", { compact: true })}
    <div class="mt">${head}</div>
    <div class="mt">${renderDiff(diff, syntax)}</div>`;
  return page({
    ctx,
    title: `${commit.subject} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
  });
}
