/**
 * Page chrome: the frames every page draws itself inside. A repo header that
 * knows its own counts and permissions, the 404 that never says whether a
 * thing exists, the settings two-pane, and the small helpers that turn a
 * `Ctx` into a repo.
 *
 * Anything here may read the database (counts, permissions); anything in
 * `ui.ts` may not. That is the line between the two files.
 */

import { countIssues } from "../core/issues.ts";
import { isPinned } from "../core/pins.ts";
import { canAdmin, canRead, getRepo, getRepoById } from "../core/repos.ts";
import type { Repo } from "../core/repos.ts";
import type { Ctx } from "../http/context.ts";
import { html, raw, when, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { page, redirect, type PaletteItem } from "./layout.ts";
import { badge, btn, empty, iconBtn, tabs, type TabItem } from "./ui.ts";

// ---- loading ----

/** The repo, if the viewer may see it. Missing and hidden are the same
 * answer on purpose, so a private repo never leaks its existence. */
export function loadRepo(ctx: Ctx): Repo | undefined {
  const repo = getRepo(
    ctx.app.db,
    ctx.params.owner ?? "",
    (ctx.params.name ?? "").replace(/\.git$/, ""),
  );
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return undefined;
  return repo;
}

export const repoBase = (repo: Repo): string =>
  `/${repo.ownerName}/${repo.name}`;

export function crumbsFor(repo: Repo): { label: string; href: string }[] {
  return [
    { label: repo.ownerName, href: `/${repo.ownerName}` },
    { label: repo.name, href: repoBase(repo) },
  ];
}

/** The one 404 in the product: same words for "no such thing" and "not
 * yours to see". */
export function notFoundPage(ctx: Ctx): Response {
  return page(
    {
      ctx,
      title: "Not found",
      body: html`<div class="page-head"><h1>404</h1></div>
        ${empty({
          icon: "search",
          title: "Nothing here",
          note: "The page you asked for does not exist, or is not visible to you.",
          action: btn("Go home", { href: "/", variant: "primary" }),
        })}`,
    },
    404,
  );
}

export const repoNotFound = notFoundPage;

/** Send an anonymous visitor to sign in, and back where they were going. */
export function signInFirst(ctx: Ctx): Response {
  const next = ctx.url.pathname + ctx.url.search;
  return redirect(`/signin?next=${encodeURIComponent(next)}`);
}

// ---- repo header ----

export type RepoTab = "code" | "issues" | "pulls" | "commits" | "settings";

export interface RepoHeaderOptions {
  /** Rendered at the right of the title line (fork, clone, watch). */
  actions?: Html;
  /** Suppress the description/lineage block on deep pages. */
  compact?: boolean;
  /**
   * The page supplies its own `<h1>` (an issue title, "New pull request"), so
   * the repo name steps down to a plain element. Exactly one h1 per document.
   */
  ownTitle?: boolean;
}

/**
 * The repo header: identity, visibility, lineage, and the tab strip with
 * live counts. Settings appears only for admins — a tab that 404s is a lie
 * about what you can do.
 */
export function repoHeader(
  ctx: Ctx,
  repo: Repo,
  active: RepoTab,
  options: RepoHeaderOptions = {},
): Html {
  const base = repoBase(repo);
  const openIssues = countIssues(ctx.app.db, repo.id, "issue", "open");
  const openPulls = countIssues(ctx.app.db, repo.id, "pull", "open");
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  const parent =
    repo.forkParentId !== null
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;

  const items: TabItem[] = [
    {
      label: "Code",
      href: base,
      icon: "repo",
      current: active === "code",
      shortcut: "g c",
    },
    {
      label: "Issues",
      href: `${base}/issues`,
      icon: "issue",
      count: openIssues,
      current: active === "issues",
      shortcut: "g i",
    },
    {
      label: "Pulls",
      href: `${base}/pulls`,
      icon: "pull",
      count: openPulls,
      current: active === "pulls",
      shortcut: "g p",
    },
    {
      label: "Commits",
      href: `${base}/commits`,
      icon: "commit",
      current: active === "commits",
      shortcut: "g m",
    },
  ];
  if (admin)
    items.push({
      label: "Settings",
      href: `${base}/settings`,
      icon: "settings",
      current: active === "settings",
      shortcut: "g s",
    });

  const title = html`${icon(repo.forkParentId !== null ? "fork" : "repo")}
    <span
      ><a class="owner" href="/${repo.ownerName}">${repo.ownerName}</a
      ><span class="slash">/</span><a href="${base}">${repo.name}</a></span
    >
    ${repo.visibility === "private"
      ? badge("Private", { icon: "lock", variant: "secondary" })
      : badge("Public", { variant: "secondary" })}
    ${options.actions
      ? html`<span class="repo-actions">${options.actions}</span>`
      : null}`;

  return html`<header class="repo-head">
    ${options.ownTitle
      ? html`<div class="repo-title">${title}</div>`
      : html`<h1 class="repo-title">${title}</h1>`}
    ${when(
      !options.compact && repo.description !== "",
      () => html`<p class="repo-desc">${repo.description}</p>`,
    )}
    ${when(
      parent,
      (p) =>
        html`<p class="repo-lineage">
          forked from
          <a href="/${p.ownerName}/${p.name}">${p.ownerName}/${p.name}</a>
        </p>`,
    )}
    ${provenance(ctx, repo)} ${tabs(items, "Repository")}
  </header>`;
}

/**
 * Where this repo comes from, and whether you keep it on your machine.
 *
 * Both live on their own line rather than in the title: a `<form>` is flow
 * content and an `<h1>` takes phrasing, so a pin button *inside* the heading
 * would be markup the parser has to repair.
 */
function provenance(ctx: Ctx, repo: Repo): Html {
  const user = ctx.auth.user;
  if (repo.origin === null && user === undefined) return html``;
  const pinned = user !== undefined && isPinned(ctx.app.db, user.id, repo.id);
  return html`<div class="repo-origin">
    ${when(repo.origin, (origin) =>
      origin.htmlUrl === ""
        ? html`<span class="origin-chip"
            >${icon(origin.kind)}mirrored from ${origin.fullName}</span
          >`
        : html`<a
            class="origin-chip"
            href="${origin.htmlUrl}"
            rel="noreferrer noopener"
            title="Open ${origin.fullName} on ${hostOf(origin.htmlUrl)}"
            >${icon(origin.kind)}mirrored from ${origin.fullName}
            <span class="muted">@ ${hostOf(origin.htmlUrl)}</span></a
          >`,
    )}
    <span class="spacer"></span>
    ${when(
      user !== undefined,
      () =>
        html`<form method="post" action="${repoBase(repo)}/pin">
          <input type="hidden" name="pinned" value="${pinned ? "0" : "1"}" />
          ${iconBtn(
            pinned ? "pinOff" : "pin",
            pinned ? "Stop keeping this on my machine" : "Keep on my machine",
            { size: "sm", variant: pinned ? "secondary" : "ghost" },
          )}
        </form>`,
    )}
  </div>`;
}

/** The host part of an absolute URL, for a chip that has to stay short. */
export function hostOf(url: string): string {
  return URL.parse(url)?.host ?? url;
}

/** This repo's own rows for the command palette. */
export function repoPalette(repo: Repo): PaletteItem[] {
  const base = repoBase(repo);
  const name = `${repo.ownerName}/${repo.name}`;
  return [
    { t: `${name} — Code`, h: base, c: "This repo" },
    { t: `${name} — Issues`, h: `${base}/issues`, c: "This repo" },
    { t: `${name} — Pull requests`, h: `${base}/pulls`, c: "This repo" },
    { t: `${name} — Commits`, h: `${base}/commits`, c: "This repo" },
    { t: `${name} — New issue`, h: `${base}/issues/new`, c: "This repo" },
    { t: `${name} — Settings`, h: `${base}/settings`, c: "This repo" },
  ];
}

// ---- generic furniture ----

/** Title line with optional right-aligned actions and a subtitle. */
export function pageHead(
  title: Html | string,
  o: { actions?: Html; sub?: Html | string; lead?: Html } = {},
): Html {
  return html`<div class="page-head">
    ${o.lead ?? null}
    <h1>${title}</h1>
    ${o.actions ? html`<span class="spacer"></span>${o.actions}` : null}
    ${o.sub ? html`<span class="sub">${o.sub}</span>` : null}
  </div>`;
}

export interface SettingsSection {
  label: string;
  href: string;
  icon?: Parameters<typeof icon>[0];
  current?: boolean;
}

/** The settings two-pane: a sticky section list beside the content on a
 * desktop, the same scroll strip as the repo tabs on a phone. */
export function settingsLayout(
  sections: SettingsSection[],
  body: Html,
  ariaLabel = "Settings sections",
): Html {
  return html`<div class="settings">
    <nav class="settings-nav" aria-label="${ariaLabel}">
      ${sections.map(
        (s) =>
          html`<a
            href="${s.href}"
            ${s.current ? raw('aria-current="page"') : null}
            >${s.icon ? icon(s.icon) : null}${s.label}</a
          >`,
      )}
    </nav>
    <div class="settings-main">${body}</div>
  </div>`;
}

/** A bottom-sticky primary action: on a phone the verb the page exists for
 * stays inside thumb reach. */
export function stickyAction(content: Html): Html {
  return html`<div class="sticky-action">${content}</div>`;
}
