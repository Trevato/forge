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
import { mayReadRuns } from "../actions/runs.ts";
import { getAppByRepo } from "../core/apps.ts";
import { audienceFacts, audienceOf } from "../core/audience.ts";
import { activeEdgeToken, edgeLoginUrl, edgeStrangerLogin } from "../http/edge.ts";
import {
  canAdmin,
  canRead,
  forkParentFor,
  getRepo,
  visibleForks,
} from "../core/repos.ts";
import type { Repo } from "../core/repos.ts";
import { parentUrl, shownTrail, sourceLabel } from "../core/provenance.ts";
import type { Database } from "bun:sqlite";
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
 * yours to see". With no session, on a GET, it also offers sign-in back to
 * this address; `plain` leaves that out for a miss that must reveal nothing
 * (a dead `/go/:code`). */
export function notFoundPage(ctx: Ctx, opts: { plain?: boolean } = {}): Response {
  const offerSignIn =
    !opts.plain && ctx.auth.user === undefined && ctx.request.method === "GET";
  return page(
    {
      ctx,
      title: "Not found",
      body: html`<div class="page-head"><h1>404</h1></div>
        ${empty({
          icon: "search",
          title: "Nothing here",
          note: "The page you asked for does not exist, or is not visible to you.",
          action: offerSignIn
            ? btn("Sign in", { href: signInHref(ctx), variant: "primary" })
            : btn("Go home", { href: "/", variant: "primary" }),
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
  if (edgeStrangerLogin(ctx.request, activeEdgeToken(ctx.app), ctx.auth.user) !== undefined)
    return "/signup";
  if (activeEdgeToken(ctx.app) !== undefined) return edgeLoginUrl(next);
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
  | "settings"
  /** A page that belongs to no tab (waves): nothing is marked current. */
  | "none";

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
      // Issues and pull requests are called that in every mode (#3241).
      label: "Issues",
      href: tellsHref(base),
      icon: "issue",
      ...(facts.openIssues === null ? {} : { count: facts.openIssues }),
      current: active === "issues",
      shortcut: "g i",
    },
    {
      label: "Pulls",
      href: changesHref(base),
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
        ? html`<a class="muted" href="/${owner}">${owner}</a>`
        : html`<span class="muted">${owner}</span>`}<span class="sep">/</span
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
    ${repo === undefined ? null : audienceLine(ctx, repo, admin, base)}
    ${when(
      !options.compact && facts.description !== "",
      () => html`<p class="muted small">${facts.description}</p>`,
    )}
    ${repo === undefined ? null : lineageLine(ctx.app.db, repo, parent)}
    ${when(
      scope.upstream !== undefined && upstreamHref(scope) === undefined,
      // The where strip carries "fork of octo/widgets" and links it, which
      // is where somebody is already looking to answer "which forge is
      // truth for this". This line is the fallback for the one case the
      // strip cannot link: a fork whose origin has been disconnected.
      () =>
        html`<p class="muted small break">
          ${icon("fork", 16)}fork of
          <span class="mono">${scope.upstream}</span>
        </p>`,
    )}
    ${studio ? studioOriginNote(repo) : whereRow(ctx, scope)}
    ${tabs(items, "Repository")}
  </header>`;
}

/**
 * The trail up, as one quiet line however it was built (#3293): "forked
 * from alice/arm" for a fork made here, "Migrated from github.com/a/arm ·
 * fork of b/arm" for a repository brought here, and the two joined when a
 * fork here was made of a migrated one. Every segment links up; a link off
 * this forge opens the original and hands it nothing (`noopener
 * noreferrer`). A migrated trail whose owner turned it off is not drawn.
 */
export function lineageLine(
  db: Database,
  repo: Repo,
  parent: Repo | undefined,
): Html | null {
  const shown = shownTrail(db, repo, parent);
  if (parent === undefined && shown === undefined) return null;
  const out = (href: string, text: string): Html =>
    html`<a href="${href}" rel="noopener noreferrer">${text}</a>`;
  const segments: Html[] = [];
  if (parent !== undefined)
    segments.push(
      html`forked from
        <a href="/${parent.ownerName}/${parent.name}"
          >${parent.ownerName}/${parent.name}</a
        >`,
    );
  if (shown !== undefined) {
    segments.push(
      html`${segments.length === 0 ? "Migrated" : "migrated"} from
      ${out(shown.sourceUrl, sourceLabel(shown.sourceUrl))}`,
    );
    for (const p of shown.parents)
      segments.push(html`fork of ${out(parentUrl(shown.sourceUrl, p), p)}`);
  }
  return html`<p class="muted small break" data-lineage>
    ${segments.map((s, i) => (i === 0 ? s : html` · ${s}`))}
  </p>`;
}

/**
 * Who can see this repository, in the one sentence `audienceOf` gives, on a
 * line under the title. The Public/Private badge in the title says the code's
 * visibility; a Split repository (public code, private app) is the case it
 * cannot say, so only then does a badge lead the sentence. The sentence is the
 * link to the settings for whoever can open them.
 */
function audienceLine(ctx: Ctx, repo: Repo, admin: boolean, base: string): Html {
  const { level, sentence } = audienceOf(audienceFacts(ctx.app.db, repo, ctx.auth.user));
  const split = level === "split" ? html`${badge("Split", { tone: "attn" })} ` : null;
  return html`<p class="repo-desc">
    ${split}${admin ? html`<a href="${base}/settings">${sentence}</a>` : sentence}
  </p>`;
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
      { t: `${name} — Issues`, h: tellsHref(base), c: "This repo" },
      { t: `${name} — Pull requests`, h: changesHref(base), c: "This repo" },
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
    ${o.sub ? html`<span class="page-head-sub muted small">${o.sub}</span>` : null}
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
