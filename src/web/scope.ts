/**
 * A repository page's *situation*: which source it reads, where its URLs
 * live, and what the viewer may do with it.
 *
 * `view/source.ts` answers "what does this repository contain". This file
 * answers the two questions a screen also needs and a source deliberately
 * does not know: **what does a link to the next page look like**, and **where
 * is the reader standing**. A `RepoScope` carries both, so exactly one set of
 * page renderers serves a repository we hold and a repository we are only
 * looking at over somebody else's API.
 *
 * The visible half of that is the *where strip*: three places, always in the
 * same order, always in the same words.
 *
 *     ● codeberg.org · ○ workbench · ○ this machine     a live browse
 *     ● codeberg.org · ● workbench (synced 3m ago) · ◆ this machine
 *     ● workbench · ○ this machine                      a native repo
 *
 * Filled means present, hollow means absent, the diamond means "kept on my
 * machine", and the accent-coloured one is the place the bytes on this page
 * actually came from. Nobody should ever have to guess whether they are
 * looking at a clone or at somebody else's server.
 */

import { parseFrom } from "../actions/tell_from.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { isPinned } from "../core/pins.ts";
import {
  getOriginRepo,
  originForRepo,
  repoForkOf,
  type Origin,
} from "../core/origins.ts";
import { canWrite, countsForRepos, type Repo } from "../core/repos.ts";
import { denied } from "../origins/operator.ts";
import type { Ctx } from "../http/context.ts";
import type {
  RepoFacts,
  RepoSource,
  SourceCapabilities,
} from "../view/source.ts";
import { localSource } from "../view/local.ts";
import { html, when, type Html } from "./html.ts";
import { repoSteps } from "./repo_steps.ts";
import { icon, type IconName } from "./icons.ts";
import type { PaletteItem } from "./layout.ts";
import { timeAgo } from "./ui.ts";

/** Which side of the world a page is reading. */
export type ScopeKind = "local" | "origin";

export interface RepoScope {
  readonly kind: ScopeKind;
  readonly source: RepoSource;
  /**
   * Resolved once per request. A live browse pays a (cached) round trip for
   * these, so a page asks the scope and never the source a second time.
   */
  readonly facts: RepoFacts;
  /** Every URL this repository has on this surface hangs off here. */
  readonly base: string;
  readonly fullName: string;
  readonly caps: SourceCapabilities;
  /** The row on our disk, when there is one. */
  readonly repo: Repo | undefined;
  /** The connected account we are borrowing, on a live browse. */
  readonly origin: Origin | undefined;
  /** The canonical page for this repository at its origin, if it has one. */
  readonly originUrl: string;
  /** A mirror of the repository being browsed, when one already exists. */
  readonly mirror: Repo | undefined;
  /**
   * `owner/name` at the origin that this repository is *my fork of*, when it
   * is one. The fork flow records it (`setRepoForkOf`); it is the lineage a
   * native fork gets from `forkParentId`, for a fork that lives on somebody
   * else's forge.
   */
  readonly upstream: string | undefined;
  /**
   * Where a change made here has to go, when it cannot simply be committed.
   * Set exactly when the origin says this account may **not** push to the
   * repository — on a live browse of it, or on a mirror of it. A native
   * repo, and a mirror you may push through, take the ordinary editor.
   */
  readonly propose: ProposeTarget | undefined;
  readonly crumbs: { label: string; href: string }[];
  readonly palette: PaletteItem[];
}

/**
 * What a repository proposes changes *to*, and through what.
 *
 * The whole workflow in five fields: the repo the pull opens on, the fork
 * the commit lands in, where the form posts, and whether a fork is needed at
 * all. `actions/contribute.ts` decides the last one for real — this is the
 * same question asked early, so the page can say what is about to happen
 * before anybody types twenty minutes of it.
 */
export interface ProposeTarget {
  readonly originId: string;
  /** `owner/name` at the origin — where the pull request opens. */
  readonly upstream: string;
  /**
   * `owner/name` of your fork of it at the origin. The conventional name
   * (`<your login>/<repo>`) when you have no fork yet, because that is
   * exactly the one `forkOrigin` will make.
   */
  readonly fork: string;
  readonly host: string;
  /** Where the contribute form POSTs. */
  readonly action: string;
}

/** The conventional fork name for `owner/name` under `login`. */
const forkNameFor = (login: string, fullName: string): string =>
  `${login}/${fullName.split("/")[1] ?? fullName}`;

/** `codeberg.org` out of `https://codeberg.org/octo/widgets`; "" for anything that is not a URL with a host. */
export function hostOf(url: string): string {
  return URL.parse(url)?.host ?? "";
}

// ---- building one ----

/**
 * A repository we hold. The facts come off the row and the index rather than
 * from `describe()`: every number here is one already-indexed query, and
 * spawning a `git log` to date-stamp a page nobody asked to date-stamp is a
 * cost a local page never used to pay.
 */
export function localScope(ctx: Ctx, repo: Repo): RepoScope {
  const base = `/${repo.ownerName}/${repo.name}`;
  const source = localSource(ctx.app, repo, ctx.auth.user);
  // Only a mirror has an upstream, so only a mirror pays for these reads.
  const mirrored = repo.origin === null ? undefined : mirrorFacts(ctx, repo);
  // One grouped query for both tab counts — the same helper a repo *list*
  // uses, asked for a list of one, rather than two count queries per page.
  const counts = repo.counts ??
    countsForRepos(ctx.app.db, [repo.id]).get(repo.id) ?? {
      openIssues: 0,
      openPulls: 0,
    };
  return {
    kind: "local",
    source,
    facts: {
      owner: repo.ownerName,
      name: repo.name,
      description: repo.description,
      visibility: repo.visibility,
      defaultBranch: repo.defaultBranch,
      openIssues: counts.openIssues,
      openPulls: counts.openPulls,
      pushedAt: null,
      htmlUrl: repo.origin?.htmlUrl ?? null,
    },
    base,
    fullName: `${repo.ownerName}/${repo.name}`,
    caps: {
      write:
        ctx.auth.user !== undefined &&
        canWrite(ctx.app.db, repo, ctx.auth.user),
      mirror: false,
      pin: ctx.auth.user !== undefined,
    },
    repo,
    origin: undefined,
    originUrl: repo.origin?.htmlUrl ?? "",
    mirror: undefined,
    upstream: mirrored?.upstream,
    propose: mirrored?.propose,
    crumbs: [
      { label: repo.ownerName, href: `/${repo.ownerName}` },
      { label: repo.name, href: base },
    ],
    palette: repoPalette(ctx, repo),
  };
}

/**
 * The two things a mirror knows that a native repo does not: what it is a
 * fork of, and whether a change made here can be pushed upstream at all.
 *
 * `can_push` is the origin's own answer, cached on the picker row when the
 * mirror was made. Absent (a repository mirrored before the column existed,
 * say) it is read as "yes" — an editor that fails loudly with the origin's
 * refusal beats an editor that quietly hides itself.
 */
function mirrorFacts(
  ctx: Ctx,
  repo: Repo,
): { upstream: string | undefined; propose: ProposeTarget | undefined } {
  const upstream = repoForkOf(ctx.app.db, repo.id) ?? undefined;
  const link = originForRepo(ctx.app.db, repo.id);
  if (link === undefined) return { upstream, propose: undefined };
  const cached = getOriginRepo(ctx.app.db, link.origin.id, link.fullName);
  // A repository the operator protects takes no pushes from here, whatever
  // the account could do: it, too, is proposed to through a fork.
  if (cached?.canPush !== false && !denied(link.origin, link.fullName))
    return { upstream, propose: undefined };
  return {
    upstream,
    propose: {
      originId: link.origin.id,
      upstream: link.fullName,
      fork: forkNameFor(link.origin.login, link.fullName),
      host: hostOf(link.origin.webUrl),
      action: `/${repo.ownerName}/${repo.name}/contribute`,
    },
  };
}

/** The URL prefix a live browse of `owner/name` on this origin lives at. */
export const browseBase = (originId: string, fullName: string): string =>
  `/origins/${originId}/r/${fullName}`;

/**
 * A repository on somebody else's forge, read live. One `describe()` per
 * request, here, so a page composed of six components makes one API call
 * rather than six.
 */
export async function originScope(
  origin: Origin,
  source: RepoSource,
): Promise<RepoScope | undefined> {
  const described = await source.describe();
  if (!described.ok) return undefined;
  const facts = described.value;
  const where = source.where;
  const fullName =
    where.kind === "origin" ? where.fullName : `${facts.owner}/${facts.name}`;
  const base = browseBase(origin.id, fullName);
  return {
    kind: "origin",
    source,
    facts,
    base,
    fullName,
    caps: source.capabilities,
    repo: undefined,
    origin,
    originUrl: facts.htmlUrl ?? (where.kind === "origin" ? where.htmlUrl : ""),
    mirror: where.kind === "origin" ? where.mirroredAs : undefined,
    // A live browse does not ask the origin who its parent is: `describe()`
    // carries no parent, and one more round trip to decorate a header is not
    // worth it. Lineage appears once the fork is mirrored here.
    upstream: undefined,
    // A repository the origin says you *can* push to needs no fork: mirror
    // it and edit it here, which is the flow the header already offers. One
    // you cannot push to is what the propose card exists for.
    ...(facts.permissions?.push === false
      ? {
          propose: {
            originId: origin.id,
            upstream: fullName,
            fork: forkNameFor(origin.login, fullName),
            host: hostOf(origin.webUrl),
            action: `${base}/contribute`,
          },
        }
      : { propose: undefined }),
    crumbs: [
      {
        label: hostOf(origin.webUrl),
        href: `/settings/origins/${origin.id}/repos`,
      },
      { label: fullName, href: base },
    ],
    palette: originPalette(base, fullName, facts.htmlUrl ?? (where.kind === "origin" ? where.htmlUrl : ""), hostOf(origin.webUrl)),
  };
}

/**
 * "Tell the crew" for the palette, on an app, for who may direct its crew
 * (`mayDirectCrew`: nobody else is offered a door that leads nowhere).
 * Where it goes depends on the page: the app's own box on the app's page,
 * else the composer carrying this page's path as `from`
 * (`studio/tell_here.ts`), which the palette's script opens in place.
 */
export function tellRow(ctx: Ctx, repo: Repo, group: string): PaletteItem[] {
  if (!mayDirectCrew(ctx.app.db, repo, ctx.auth.user)) return [];
  const base = `/${repo.ownerName}/${repo.name}`;
  const path = ctx.url.pathname;
  const h =
    path === base || path === `${base}/tell` || parseFrom(path) !== path
      ? `${base}#tell`
      : `${base}/tell?from=${encodeURIComponent(path)}`;
  return [{ t: `${base.slice(1)} — Tell the crew`, h, c: group }];
}

/**
 * This repo's rows for the command palette: every step the head offers, on
 * the head's own conditions (`repoSteps`), in the studio's nouns for an app —
 * plus the one first verb a step list has no word for: telling the crew on an
 * app (it posts from the app page itself), a new issue anywhere else.
 */
export function repoPalette(ctx: Ctx, repo: Repo): PaletteItem[] {
  const base = `/${repo.ownerName}/${repo.name}`;
  const name = `${repo.ownerName}/${repo.name}`;
  const here = "This repository";
  const { steps, studio } = repoSteps(ctx, base, repo);
  const rows: PaletteItem[] = steps.map((st) => ({
    t: `${name} — ${st.label === "Pulls" ? "Pull requests" : st.label}`,
    h: st.href,
    c: here,
  }));
  return studio
    ? [...rows, ...tellRow(ctx, repo, here)]
    : [...rows, { t: `${name} — New issue`, h: `${base}/issues/new`, c: here }];
}

/** A browsed repository's rows: its code, issues, pull requests, commits and the way out to its origin. */
function originPalette(base: string, name: string, away: string, host: string): PaletteItem[] {
  const here = "This repository";
  return [
    { t: `${name} — Code`, h: base, c: here },
    { t: `${name} — Issues`, h: `${base}/issues`, c: here },
    { t: `${name} — Pull requests`, h: `${base}/pulls`, c: here },
    { t: `${name} — Commits`, h: `${base}/commits`, c: here },
    // The head's "More" holds the way out; so does the palette.
    ...(away === "" ? [] : [{ t: `${name} — Open on ${host}`, h: away, c: here }]),
  ];
}

// ---- the where strip ----

type PlaceState = "reading" | "present" | "absent";

interface Place {
  label: string;
  state: PlaceState;
  /** ● present · ○ absent · ◆ kept on this machine. */
  glyph: "●" | "○" | "◆";
  href?: string;
  external?: boolean;
  /** A parenthesised aside, e.g. "(synced 3m ago)". */
  note?: string;
  title?: string;
  icon?: IconName;
  /** Submits the form with this id — the pin toggle, which is a mutation. */
  form?: string;
}

const PIN_FORM = "where-pin";

/** The three places, in order, for whichever situation this scope is in. */
function placesFor(ctx: Ctx, scope: RepoScope): Place[] {
  const places: Place[] = [];
  const user = ctx.auth.user;

  // 1. the origin.
  if (scope.kind === "origin" && scope.origin !== undefined) {
    places.push({
      label: hostOf(scope.origin.webUrl),
      state: "reading",
      glyph: "●",
      icon: scope.origin.kind,
      ...(scope.originUrl === ""
        ? {}
        : { href: scope.originUrl, external: true }),
      title: `Reading ${scope.fullName} live from ${hostOf(scope.origin.webUrl)}`,
    });
  } else if (scope.repo?.origin != null) {
    const at = scope.repo.origin;
    places.push({
      label: at.htmlUrl === "" ? at.fullName : hostOf(at.htmlUrl),
      state: "present",
      glyph: "●",
      icon: at.kind,
      ...(at.htmlUrl === "" ? {} : { href: at.htmlUrl, external: true }),
      // A fork says so right here, where you are already reading "which
      // forge is truth for this" — the one line that stops somebody
      // proposing a change to their own copy and wondering why nobody saw it.
      ...(scope.upstream === undefined
        ? {}
        : { note: `fork of ${scope.upstream}` }),
      title:
        scope.upstream === undefined
          ? `mirrored from ${at.fullName}`
          : `${at.fullName} is my fork of ${scope.upstream}`,
    });
  }

  // 2. the workbench — this forge.
  if (scope.kind === "local") {
    const fetched = scope.repo?.origin?.lastFetchAt ?? null;
    places.push({
      label: "workbench",
      state: "reading",
      glyph: "●",
      href: scope.base,
      ...(fetched === null ? {} : { note: `synced ${timeAgo(fetched)}` }),
      title: "Reading from this forge",
    });
  } else if (scope.mirror !== undefined) {
    const mirror = scope.mirror;
    places.push({
      label: "workbench",
      state: "present",
      glyph: "●",
      href: `/${mirror.ownerName}/${mirror.name}`,
      title: `Mirrored here as ${mirror.ownerName}/${mirror.name}`,
    });
  } else {
    places.push({
      label: "workbench",
      state: "absent",
      glyph: "○",
      title: "Not mirrored here yet",
    });
  }

  // 3. this machine — the pin.
  const repo = scope.repo;
  const pinned =
    repo !== undefined &&
    user !== undefined &&
    isPinned(ctx.app.db, user.id, repo.id);
  if (repo !== undefined && user !== undefined) {
    places.push({
      label: "this machine",
      state: pinned ? "present" : "absent",
      glyph: pinned ? "◆" : "○",
      form: PIN_FORM,
      title: pinned
        ? "Stop keeping this repository on my machine"
        : "Keep this repository on my machine",
    });
  } else {
    places.push({
      label: "this machine",
      state: "absent",
      glyph: "○",
      ...(scope.kind === "origin"
        ? { title: "Mirror it first, then keep it on your machine" }
        : {}),
    });
  }
  return places;
}

function placeNode(place: Place): Html {
  const inner = html`<span aria-hidden="true"
      >${place.glyph}</span
    >${place.icon ? icon(place.icon) : null}<span class="where-name"
      >${place.label}</span
    >${place.note
      ? html`<span class="muted">(${place.note})</span>`
      : null}`;
  const attrs = html`class="where-place" data-state="${place.state}"
  ${place.title ? html`title="${place.title}"` : null}`;
  if (place.form !== undefined) {
    return html`<button ${attrs} type="submit" form="${place.form}">
      ${inner}
    </button>`;
  }
  if (place.href !== undefined) {
    return html`<a
      ${attrs}
      href="${place.href}"
      ${place.external ? html`rel="noreferrer noopener" target="_blank"` : null}
      >${inner}</a
    >`;
  }
  return html`<span ${attrs}>${inner}</span>`;
}

/**
 * The strip itself. It is the same three words on every repository page in
 * the product, so where you are reading from is never a thing you work out
 * from context.
 */
export function whereStrip(ctx: Ctx, scope: RepoScope): Html {
  const places = placesFor(ctx, scope);
  return html`<div
    class="where"
    aria-label="Where this repository is read from"
  >
    ${places.map(
      (place, i) =>
        html`${i > 0
          ? html`<span class="sep" aria-hidden="true">·</span>`
          : null}${placeNode(place)}`,
    )}
  </div>`;
}

/**
 * The strip plus the pin toggle it drives. The toggle is a mutation, so it is
 * a real form; the strip's third place submits it by id, which is what lets a
 * `<button>` sit inside a row of links without nesting a form in a heading.
 */
export function whereRow(ctx: Ctx, scope: RepoScope): Html {
  const repo = scope.repo;
  const user = ctx.auth.user;
  const canPin = repo !== undefined && user !== undefined;
  const pinned = canPin && isPinned(ctx.app.db, user.id, repo.id);
  return html`<div class="repo-where">
    ${whereStrip(ctx, scope)}
    <span class="spacer"></span>
    ${when(
      canPin,
      () =>
        html`<form
          method="post"
          action="${scope.base}/pin"
          id="${PIN_FORM}"
          class="where-pin"
        >
          <input type="hidden" name="pinned" value="${pinned ? "0" : "1"}" />
        </form>`,
    )}
  </div>`;
}

/**
 * The studio's own answer to "where does this app's bytes live", for a
 * repository the studio owns end to end. A native app is the studio's alone
 * — there is nothing to say, so a caller in studio mode draws no strip at
 * all rather than dev's three-place diagram of a git remote nobody here
 * reads dev's words for. A mirrored app still owes a reader the one fact
 * the strip carried — where it reads from, and how fresh — said as a
 * sentence instead of dots.
 */
export function studioOriginNote(repo: Repo | undefined): Html | null {
  const at = repo?.origin;
  if (at == null) return null;
  const host = at.htmlUrl === "" ? at.fullName : hostOf(at.htmlUrl);
  return html`<p class="muted small break">
    Reads from
    ${at.htmlUrl === ""
      ? host
      : html`<a href="${at.htmlUrl}" rel="noreferrer noopener" target="_blank"
          >${host}</a
        >`}${at.lastFetchAt === null
      ? ""
      : html`, synced ${timeAgo(at.lastFetchAt)}`}
  </p>`;
}

/**
 * The banner a live browse carries above its content. Deliberately quiet and
 * deliberately unmissable: it says what you are looking at, that you cannot
 * change it, and what to do about that.
 */
export function liveBanner(scope: RepoScope): Html {
  if (scope.kind !== "origin" || scope.origin === undefined) return html``;
  const host = hostOf(scope.origin.webUrl);
  return html`<div class="live-note" role="note">
    ${icon("globe", 16)}
    <p>
      Reading live from <strong>${host}</strong> — read-only. Mirror it to
      comment, push and keep it in sync.
    </p>
  </div>`;
}

/**
 * Where the repository this one forks can be read: the live browse of it on
 * the same origin, because that is a page in this product which then offers
 * Fork, Propose a change, and its pull list. A link straight out to the
 * origin drops you out of the workflow you are in the middle of.
 */
export function upstreamHref(scope: RepoScope): string | undefined {
  const originId = scope.repo?.origin?.originId ?? scope.origin?.id;
  if (scope.upstream === undefined || originId === undefined) return undefined;
  return browseBase(originId, scope.upstream);
}

/** Whether `owner/name` belongs to the connected account itself. */
export const isOwnRepo = (login: string, fullName: string): boolean =>
  login !== "" && fullName.toLowerCase().startsWith(`${login.toLowerCase()}/`);

/**
 * Fork it, at the origin.
 *
 * The one write a live browse makes on somebody else's forge, and the first
 * step of the workflow this whole surface exists for: grab their repo,
 * branch, edit, propose it back. Not offered on a repository the connected
 * account already owns — neither forge forks you to yourself.
 */
export function forkButton(scope: RepoScope): Html {
  const origin = scope.origin;
  if (scope.kind !== "origin" || origin === undefined) return html``;
  if (isOwnRepo(origin.login, scope.fullName)) return html``;
  return html`<form method="post" action="${scope.base}/fork">
    <button
      class="menu-item"
      type="submit"
      title="Fork ${scope.fullName} into your account at ${hostOf(
        origin.webUrl,
      )}"
    >
      ${icon("fork", 16)}<span class="grow">Fork</span>
    </button>
  </form>`;
}

/**
 * What a live browse offers instead of the write affordances: one primary
 * verb in a fixed place, and the rest (fork it, the way out to the forge that
 * owns this repository) in an overflow beside it.
 */
export function browseActions(scope: RepoScope): Html {
  if (scope.kind !== "origin" || scope.origin === undefined) return html``;
  const host = hostOf(scope.origin.webUrl);
  const mirror = scope.mirror;
  const primary =
    mirror === undefined
      ? html`<form method="post" action="${scope.base}/mirror">
          <button class="btn" data-variant="primary" data-size="sm" type="submit">
            ${icon("download", 16)}Mirror into your workbench
          </button>
        </form>`
      : html`<a
          class="btn"
          data-variant="primary"
          data-size="sm"
          href="/${mirror.ownerName}/${mirror.name}"
          >${icon("repo", 16)}Open the mirror</a
        >`;
  const fork = forkButton(scope);
  const away =
    scope.originUrl === ""
      ? null
      : html`<a
          class="menu-item"
          href="${scope.originUrl}"
          target="_blank"
          rel="noopener noreferrer"
          >${icon("external", 16)}<span class="grow">Open on ${host}</span></a
        >`;
  if (fork.text.trim() === "" && away === null) return primary;
  return html`${primary}<details class="menu" data-align="end">
    <summary class="btn" data-variant="ghost" data-size="sm" aria-label="More actions">More</summary>
    <div class="menu-panel">${fork}${away}</div>
  </details>`;
}
