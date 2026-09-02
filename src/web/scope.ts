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

import { countIssues } from "../core/issues.ts";
import { isPinned } from "../core/pins.ts";
import type { Origin } from "../core/origins.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { Ctx } from "../http/context.ts";
import type {
  RepoFacts,
  RepoSource,
  SourceCapabilities,
} from "../view/source.ts";
import { localSource } from "../view/local.ts";
import { html, when, type Html } from "./html.ts";
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
  readonly crumbs: { label: string; href: string }[];
  readonly palette: PaletteItem[];
}

/** `codeberg.org` out of `https://codeberg.org/octo/widgets`. */
export function hostOf(url: string): string {
  return URL.parse(url)?.host ?? url;
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
  return {
    kind: "local",
    source,
    facts: {
      owner: repo.ownerName,
      name: repo.name,
      description: repo.description,
      visibility: repo.visibility,
      defaultBranch: repo.defaultBranch,
      openIssues: countIssues(ctx.app.db, repo.id, "issue", "open"),
      openPulls: countIssues(ctx.app.db, repo.id, "pull", "open"),
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
    crumbs: [
      { label: repo.ownerName, href: `/${repo.ownerName}` },
      { label: repo.name, href: base },
    ],
    palette: repoPalette(base, `${repo.ownerName}/${repo.name}`, true),
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
    crumbs: [
      {
        label: hostOf(origin.webUrl),
        href: `/settings/origins/${origin.id}/repos`,
      },
      { label: fullName, href: base },
    ],
    palette: repoPalette(base, fullName, false),
  };
}

function repoPalette(
  base: string,
  name: string,
  local: boolean,
): PaletteItem[] {
  const items: PaletteItem[] = [
    { t: `${name} — Code`, h: base, c: "This repo" },
    { t: `${name} — Issues`, h: `${base}/issues`, c: "This repo" },
    { t: `${name} — Pull requests`, h: `${base}/pulls`, c: "This repo" },
    { t: `${name} — Commits`, h: `${base}/commits`, c: "This repo" },
  ];
  if (local) {
    items.push(
      { t: `${name} — New issue`, h: `${base}/issues/new`, c: "This repo" },
      { t: `${name} — Settings`, h: `${base}/settings`, c: "This repo" },
    );
  }
  return items;
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
      title: `mirrored from ${at.fullName}`,
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
  const inner = html`<span class="where-dot" aria-hidden="true"
      >${place.glyph}</span
    >${place.icon ? icon(place.icon) : null}<span class="where-name"
      >${place.label}</span
    >${place.note
      ? html`<span class="where-note">(${place.note})</span>`
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
          ? html`<span class="where-sep" aria-hidden="true">·</span>`
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
          <button
            class="btn"
            data-size="sm"
            data-variant="${pinned ? "secondary" : "outline"}"
            type="submit"
            title="${pinned
              ? "Stop keeping this repository on my machine"
              : "The local client will clone and keep this fresh"}"
          >
            ${icon(pinned ? "pin" : "pin", 16)}${pinned
              ? html`On my machine <span aria-hidden="true">◆</span>`
              : html`Keep on my machine`}
          </button>
        </form>`,
    )}
  </div>`;
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
 * What a live browse offers instead of the write affordances: one primary
 * verb, and the way out to the forge that actually owns this repository.
 */
export function browseActions(scope: RepoScope): Html {
  if (scope.kind !== "origin" || scope.origin === undefined) return html``;
  const host = hostOf(scope.origin.webUrl);
  const mirror = scope.mirror;
  return html`${mirror === undefined
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
      >`}
  ${scope.originUrl === ""
    ? null
    : html`<a
        class="btn"
        data-size="sm"
        data-variant="outline"
        href="${scope.originUrl}"
        target="_blank"
        rel="noopener noreferrer"
        >${icon("external", 16)}Open on ${host}</a
      >`}`;
}
