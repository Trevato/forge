/**
 * Page chrome: the frames every page draws itself inside. A repo header that
 * knows its own counts and permissions, the 404 that never says whether a
 * thing exists, the settings two-pane, and the small helpers that turn a
 * `Ctx` into a repo.
 *
 * Anything here may read the database (counts, permissions); anything in
 * `ui.ts` may not. That is the line between the two files.
 */

import { sshCommand } from "../ssh/command.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { mayReadRuns } from "../actions/runs.ts";
import { getAppByRepo } from "../core/apps.ts";
import { edgeLoginUrl } from "../http/edge.ts";
import {
  canAdmin,
  canRead,
  forkParentFor,
  getRepo,
  visibleForks,
} from "../core/repos.ts";
import type { Repo } from "../core/repos.ts";
import type { Ctx } from "../http/context.ts";
import { html, raw, when, type Html } from "./html.ts";
import { icon } from "./icons.ts";
import { page, redirect, type PaletteItem } from "./layout.ts";
import {
  browseActions,
  hostOf,
  tellRow,
  localScope,
  studioOriginNote,
  upstreamHref,
  whereRow,
  type RepoScope,
} from "./scope.ts";
import { changesHref, tellsHref } from "./studio/nouns.ts";
import { badge, btn, empty, tabs, type TabItem } from "./ui.ts";

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
  return redirect(signInHref(ctx));
}

/** Where signing in starts, coming back to this page after. */
export function signInHref(ctx: Ctx): string {
  const next = ctx.url.pathname + ctx.url.search;
  // Behind a platform edge the edge is how people sign in; an account it
  // made has no password here, so the password form would only refuse them.
  if (ctx.app.config.edgeToken !== undefined) return edgeLoginUrl(next);
  return `/signin?next=${encodeURIComponent(next)}`;
}

// ---- repo header ----

export type RepoTab =
  | "code"
  | "issues"
  | "pulls"
  | "forks"
  | "map"
  | "commits"
  | "branches"
  | "app"
  | "runs"
  | "settings";

export interface RepoHeaderOptions {
  /** Rendered at the right of the title line (fork, clone, watch). */
  actions?: Html;
  /** Suppress the description/lineage block on deep pages. */
  compact?: boolean;
  /**
   * How many branches this repository has, when the page already knows.
   * Counting them costs a git read and the header is on every page, so the
   * tab carries a number only where one was going to be read anyway.
   */
  branchCount?: number;
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
  return scopeHeader(ctx, localScope(ctx, repo), active, options);
}

/**
 * The one repo header, for either side of the world. Identity, the where
 * strip, and the tab strip with live counts. Settings appears only for an
 * admin of a repository we actually hold — a tab that 404s is a lie about
 * what you can do, and on a live browse there is nothing here to configure.
 */
export function scopeHeader(
  ctx: Ctx,
  scope: RepoScope,
  active: RepoTab,
  options: RepoHeaderOptions = {},
): Html {
  const base = scope.base;
  const repo = scope.repo;
  const facts = scope.facts;
  const admin = repo !== undefined && canAdmin(ctx.app.db, repo, ctx.auth.user);
  // "forked from …" names another repository, so it says nothing to somebody
  // who cannot read that one — same rule as the About rail's Fork-of row.
  const parent =
    repo === undefined
      ? undefined
      : forkParentFor(ctx.app.db, repo, ctx.auth.user);

  const isApp =
    repo !== undefined && getAppByRepo(ctx.app.db, repo.id) !== undefined;
  // An app speaks the studio's words (told, changes), a plain repository
  // git's (issues, pulls, commits, branches) — for every viewer (#603).
  const studio = isApp;
  // An app's home is the app, for every viewer, and its code is the Files
  // step one tab over (`repoFiles`); any other repository's home is its code.
  const items: TabItem[] = [
    ...(isApp
      ? [
          {
            label: studio ? "Studio" : "App",
            href: base,
            icon: "rocket" as const,
            current: active === "app",
          },
          {
            label: "Files",
            href: `${base}/files`,
            icon: "repo" as const,
            current: active === "code",
            shortcut: "g c",
          },
        ]
      : [
          {
            label: "Code",
            href: base,
            icon: "repo" as const,
            current: active === "code",
            shortcut: "g c",
          },
        ]),
    {
      // Studio names its own lists — told, not issues; a repository that is
      // not an app keeps git's words.
      label: studio ? "Told" : "Issues",
      href: studio ? tellsHref(base) : `${base}/issues`,
      icon: studio ? "clock" : "issue",
      ...(facts.openIssues === null ? {} : { count: facts.openIssues }),
      current: active === "issues",
      shortcut: "g i",
    },
    {
      // "Look" is the five-word state a green pull is in, and the name of
      // the picture card on one — not the noun for this list, which is the
      // same one `/changes` and "Every change" already use.
      label: studio ? "Changes" : "Pulls",
      href: studio ? changesHref(base) : `${base}/pulls`,
      icon: "pull",
      ...(facts.openPulls === null ? {} : { count: facts.openPulls }),
      current: active === "pulls",
      shortcut: "g p",
    },
    {
      label: "Map",
      href: `${base}/map`,
      icon: "map",
      current: active === "map",
      shortcut: "g a",
    },
    ...(studio
      ? []
      : [
          {
            label: "Commits",
            href: `${base}/commits`,
            icon: "commit" as const,
            current: active === "commits",
            shortcut: "g m",
          },
          {
            label: "Branches",
            href: `${base}/branches`,
            icon: "branch" as const,
            ...(options.branchCount === undefined
              ? {}
              : { count: options.branchCount }),
            current: active === "branches",
            shortcut: "g b",
          },
        ]),
  ];
  // The family: a repository with forks, or one that is a fork, gets a tab
  // to the tree — where each fork stands against what it follows. One with
  // neither has no family to show, and the tab stays away.
  if (repo !== undefined) {
    // Only the forks this viewer may read: a private fork is not counted.
    const forks = visibleForks(ctx.app.db, repo.id, ctx.auth.user).length;
    if (forks > 0 || repo.forkParentId !== null)
      items.splice(3, 0, {
        label: "Forks",
        href: `${base}/forks`,
        icon: "fork",
        ...(forks > 0 ? { count: forks } : {}),
        current: active === "forks",
        shortcut: "g f",
      });
  }
  // The depth row's last two steps (#603): the runs, for who may read them
  // (`mayReadRuns`: a private app's are for those who may enter it), and
  // how to open the terminal (the TUI over SSH) for whoever has keys. A
  // repository only browsed from elsewhere has no runs here.
  if (repo !== undefined && mayReadRuns(ctx.app, ctx.auth.user, repo))
    items.push({
      label: "Runs",
      href: `${base}/runs`,
      icon: "activity",
      current: active === "runs",
      shortcut: "g r",
    });
  if (ctx.auth.user !== undefined && sshCommand(ctx.app) !== undefined)
    items.push({
      label: "Terminal",
      href: "/settings/keys#terminal",
      icon: "command",
    });
  if (admin)
    items.push({
      label: "Settings",
      href: `${base}/settings`,
      icon: "settings",
      current: active === "settings",
      shortcut: "g s",
    });

  const owner = facts.owner;
  const actions = options.actions ?? browseActions(scope);
  const title = html`${icon(
      repo?.forkParentId != null || scope.upstream !== undefined
        ? "fork"
        : scope.kind === "origin"
          ? "globe"
          : "repo",
    )}
    <span
      >${scope.kind === "local"
        ? html`<a class="owner" href="/${owner}">${owner}</a>`
        : html`<span class="owner">${owner}</span>`}<span class="slash">/</span
      ><a href="${base}">${facts.name}</a></span
    >
    ${facts.visibility === "private"
      ? badge("Private", { icon: "lock", variant: "secondary" })
      : badge("Public", { variant: "secondary" })}
    ${actions.text.trim() !== ""
      ? html`<span class="repo-actions">${actions}</span>`
      : null}`;

  return html`<header class="repo-head">
    ${options.ownTitle
      ? html`<div class="repo-title">${title}</div>`
      : html`<h1 class="repo-title">${title}</h1>`}
    ${when(
      !options.compact && facts.description !== "",
      () => html`<p class="repo-desc">${facts.description}</p>`,
    )}
    ${when(
      parent,
      (p) =>
        html`<p class="repo-lineage">
          forked from
          <a href="/${p.ownerName}/${p.name}">${p.ownerName}/${p.name}</a>
        </p>`,
    )}
    ${when(
      scope.upstream !== undefined && upstreamHref(scope) === undefined,
      // The where strip carries "fork of octo/widgets" and links it, which
      // is where somebody is already looking to answer "which forge is
      // truth for this". This line is the fallback for the one case the
      // strip cannot link: a fork whose origin has been disconnected.
      () =>
        html`<p class="repo-lineage">
          ${icon("fork", 16)}fork of
          <span class="mono">${scope.upstream}</span>
        </p>`,
    )}
    ${studio ? studioOriginNote(repo) : whereRow(ctx, scope)}
    ${tabs(items, "Repository")}
  </header>`;
}

export { hostOf };

/** This repo's own rows for the command palette — the studio's nouns for a
 * studio-mode viewer of an app, so the palette never sends someone to a
 * list under a name the address bar would not use. Commits is dev's own
 * page (no studio tab reaches it, `scopeHeader` above), so it drops out of
 * a studio app's rows rather than sit there under a dev word; New issue
 * gives way to the studio's own first verb, telling the crew, which posts
 * from the app page itself (`${base}#tell`, `studio/app.ts`). */
export function repoPalette(ctx: Ctx, repo: Repo): PaletteItem[] {
  const base = repoBase(repo);
  const name = `${repo.ownerName}/${repo.name}`;
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  const studio = isApp;
  if (studio) {
    return [
      { t: `${name} — Studio`, h: base, c: "This repo" },
      { t: `${name} — Files`, h: `${base}/files`, c: "This repo" },
      { t: `${name} — Told`, h: tellsHref(base), c: "This repo" },
      { t: `${name} — Changes`, h: changesHref(base), c: "This repo" },
      // Telling the crew is for who may direct it (`mayDirectCrew`: a
      // writer, or anyone signed in where the owner let outsiders in), so
      // nobody else is offered a door that leads nowhere.
      ...tellRow(ctx, repo, "This repo"),
      ...(mayReadRuns(ctx.app, ctx.auth.user, repo)
        ? [{ t: `${name} — Runs`, h: `${base}/runs`, c: "This repo" }]
        : []),
      { t: `${name} — Settings`, h: `${base}/settings`, c: "This repo" },
    ];
  }
  return [
    ...(isApp ? [{ t: `${name} — App`, h: base, c: "This repo" }] : []),
    { t: `${name} — Code`, h: isApp ? `${base}/files` : base, c: "This repo" },
    { t: `${name} — Issues`, h: `${base}/issues`, c: "This repo" },
    { t: `${name} — Pull requests`, h: `${base}/pulls`, c: "This repo" },
    { t: `${name} — Commits`, h: `${base}/commits`, c: "This repo" },
    { t: `${name} — New issue`, h: `${base}/issues/new`, c: "This repo" },
    ...(mayReadRuns(ctx.app, ctx.auth.user, repo)
      ? [{ t: `${name} — Runs`, h: `${base}/runs`, c: "This repo" }]
      : []),
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
 * desktop, the same scroll strip as the repo tabs on a phone.
 *
 * The sections are `data-nav` rows, so `j`/`k` walk them from the one you
 * are on and Enter opens one; the main pane is the page's box, so `c`
 * lands in its first field. */
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
            data-nav
            ${s.current ? raw('aria-current="page"') : null}
            >${s.icon ? icon(s.icon) : null}${s.label}</a
          >`,
      )}
    </nav>
    <div class="settings-main" data-box="Edit the form">${body}</div>
  </div>`;
}

/** A bottom-sticky primary action: on a phone the verb the page exists for
 * stays inside thumb reach. */
export function stickyAction(content: Html): Html {
  return html`<div class="sticky-action">${content}</div>`;
}
