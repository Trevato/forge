/**
 * Repository pages: the code at a ref, one file, and the raw bytes.
 * Everything is URL-addressable and renders without JavaScript; reads go
 * straight to git, so nothing shown here is stored anywhere else.
 *
 * Every ref reaching git passes `isSafeRef` first, and every ref *leaving*
 * here in a URL is percent-encoded, so a branch called `feature/a` stays one
 * path segment and can never smuggle a path of its own.
 */

import { canRead, listForks, type Repo } from "../../core/repos.ts";
import { forkRepo } from "../../actions/repos.ts";
import { forkDrift, takeUpdates, type ForkDrift } from "../../actions/forks.ts";
import { lineageOf } from "../../core/following.ts";
import { followingCard, followingOf, lineageCard } from "./following.ts";
import { pinRepo, syncRepoNow, unpinRepo } from "../../actions/origins.ts";
import {
  canAdmin,
  canWrite,
  forkParentFor,
  visibleForks,
} from "../../core/repos.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import { blobForRender, type TreeEntry } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import { estimateTokens } from "../../kernel/tokens-format.ts";
import { safeBack, type Ctx } from "../../http/context.ts";
import { json, notFound } from "../../http/respond.ts";
import type { Blob, RepoSource } from "../../view/source.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  scopeHeader,
  signInFirst,
} from "../chrome.ts";
import { codeJs } from "../client.ts";
import { highlightBlob } from "../code.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { appStrip } from "./apps.ts";
import { studioApp } from "../studio/app.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, fragment, page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { browseBase, localScope, type RepoScope } from "../scope.ts";
import { repoForkOf } from "../../core/origins.ts";
import {
  btn,
  card,
  empty,
  fileSize,
  sizeWithTokens,
  tokenCount,
  icon,
  iconBtn,
  listCard,
  row,
  seg,
  time,
} from "../ui.ts";

const MAX_RENDER_BYTES = 1_000_000;
// A blob under the byte cap can still be pathological (a megabyte of newlines
// is ~490k lines). Bounding rendered lines bounds the response independently.
const MAX_RENDER_LINES = 5_000;

import { pathCrumbs, refMenu, refSetFrom, type RefSet } from "./refs.ts";
import {
  codeLayout,
  codeMount,
  explorerColumn,
  explorerFragment,
  finderButton,
  finderDialog,
  loadExplorer,
} from "./explorer.ts";

export { crumbsFor, loadRepo, repoBase };
export { pathCrumbs, refMenu, refSet, refSetFrom } from "./refs.ts";

// ---- fork ----

/** The parent and the forks this viewer may see, from the request. */
const forkParent = (ctx: Ctx, repo: Repo): Repo | undefined =>
  forkParentFor(ctx.app.db, repo, ctx.auth.user);
const forksFor = (ctx: Ctx, repo: Repo): Repo[] =>
  visibleForks(ctx.app.db, repo.id, ctx.auth.user);

/**
 * How far the fork has slipped from its parent, in a phrase. A fork with
 * commits of its own says so: an update would be refused, so the sentence
 * has to explain the missing button.
 */
function driftNote(drift: ForkDrift | undefined): string | undefined {
  if (drift === undefined || drift.ahead === null || drift.behind === null)
    return undefined;
  const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  const { ahead, behind } = drift;
  if (ahead === 0)
    return behind === 0 ? "up to date" : `${commits(behind)} behind`;
  if (behind === 0) return `${commits(ahead)} of its own`;
  return `${commits(ahead)} of its own, ${behind} behind — merge by hand`;
}

/**
 * Offer the update only when it would fast-forward: something to take, and
 * nothing of the fork's own in the way. Unknown drift keeps the button, since
 * the action itself is the thing that decides.
 */
function updatable(drift: ForkDrift | undefined): boolean {
  if (drift === undefined || drift.ahead === null || drift.behind === null)
    return true;
  return drift.behind > 0 && drift.ahead === 0;
}

/**
 * GET /:owner/:name/forks — every fork of this repository the viewer may
 * see, newest first. The count on the repository page is the way in.
 */
export async function forksPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const forks = listForks(ctx.app.db, repo.id).filter((fork) =>
    canRead(ctx.app.db, fork, ctx.auth.user),
  );
  // The whole family, from the oldest ancestor this viewer may see: who
  // follows whom, and where each stands against the one it follows.
  const lineage = await lineageOf(ctx.app, repo, (r) =>
    canRead(ctx.app.db, r, ctx.auth.user),
  );
  const body = html`${repoHeader(ctx, repo, "forks")}
    <div class="page-head mt">
      <h2>${forks.length} fork${forks.length === 1 ? "" : "s"}</h2>
    </div>
    ${lineage.size === 1
      ? empty({
          icon: "fork",
          title: "No forks yet",
          note: "A fork is a copy under another name that can propose changes back here, and follows this one until it has work of its own.",
        })
      : lineageCard(lineage, repo.id)}`;
  return page({ ctx, title: `Forks · ${repo.ownerName}/${repo.name}`, body });
}

/** The "forked from …" lineage line and a Fork button, for the repo home. */
function forkBar(ctx: Ctx, repo: Repo): Html {
  const canFork =
    ctx.auth.user !== undefined && ctx.auth.user.id !== repo.ownerId;
  const forkCount = forksFor(ctx, repo).length;
  if (!canFork && forkCount === 0) return html``;
  return html`<div class="fork-bar">
    ${when(
      forkCount > 0,
      () =>
        html`<a class="muted small" href="${repoBase(repo)}/forks"
          >${icon("fork")} ${forkCount} fork${forkCount === 1 ? "" : "s"}</a
        >`,
    )}
    <span class="spacer"></span>
    ${when(
      canFork,
      () =>
        html`<form method="post" action="${repoBase(repo)}/fork">
          ${btn("Fork", { size: "sm", icon: "fork" })}
        </form>`,
    )}
  </div>`;
}

// POST /:owner/:name/fork
export async function forkSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const forked = await forkRepo(
    ctx.app,
    ctx.auth.user,
    repo,
    field(form, "name") || undefined,
  );
  if (!forked.ok) {
    const reason =
      forked.error === "name_taken"
        ? "You already have a repository by that name."
        : "That fork could not be created.";
    return flashTo(ctx, repoBase(repo), { tone: "danger", message: reason });
  }
  return flashTo(ctx, repoBase(forked.value), {
    message: `Forked to ${forked.value.ownerName}/${forked.value.name}.`,
  });
}

// ---- mirrors and pins ----

// POST /:owner/:name/sync — pull this mirror now. Any writer may ask: it only
// fetches, so it borrows nobody's identity and grants nobody anything.
export async function repoSyncSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // A native fork takes from its parent; a mirror from its origin.
  if (repo.origin === null && repo.forkParentId !== null) {
    const took = await takeUpdates(ctx.app, ctx.auth.user, repo);
    if (!took.ok) {
      const e = took.error;
      return flashTo(ctx, repoBase(repo), {
        tone: "danger",
        message:
          typeof e === "string"
            ? e === "not_a_fork"
              ? "This repository has no parent to follow."
              : "You need write access to update this fork."
            : e.kind === "conflict"
              ? `${repo.defaultBranch} and the parent both changed ${e.files.join(", ")}; the crew can converge it.`
              : e.kind === "moved"
                ? "Something moved while this was read; try again."
                : `Git could not take the updates: ${e.message}`,
      });
    }
    return flashTo(ctx, repoBase(repo), {
      message: took.value.updated
        ? `${took.value.merged ? "Merged" : "Updated"} ${repo.defaultBranch} to ${took.value.to.slice(0, 7)}.`
        : "Already up to date with the parent.",
    });
  }
  const synced = await syncRepoNow(ctx.app, ctx.auth.user, repo);
  if (!synced.ok)
    return flashTo(ctx, repoBase(repo), {
      tone: "danger",
      message:
        synced.error === "not_found"
          ? "This repository does not mirror an origin."
          : "You need write access to sync this mirror.",
    });
  return flashTo(ctx, repoBase(repo), {
    ...(synced.value.error === ""
      ? { message: "Synced from the origin." }
      : { tone: "danger" as const, message: synced.value.error }),
  });
}

/**
 * POST /:owner/:name/pin — "keep this on my machine", toggled.
 *
 * The state being asked for travels in the form rather than being read back
 * out of the database, so a double submit is idempotent instead of a
 * flip-flop.
 */
export async function pinSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const wanted = field(form, "pinned") !== "0";
  const done = wanted
    ? pinRepo(ctx.app, ctx.auth.user, repo)
    : unpinRepo(ctx.app, ctx.auth.user, repo);
  const back = safeBack(ctx) ?? repoBase(repo);
  if (!done.ok && wanted)
    return flashTo(ctx, back, {
      tone: "danger",
      message: "That could not be pinned.",
    });
  return flashTo(ctx, back, {
    message: wanted
      ? "Pinned. The local client keeps it cloned on your machine."
      : "Unpinned.",
  });
}

// ---- shared pieces ----

/**
 * One directory level. Takes a URL base rather than a repository, so the same
 * listing renders for a repo we hold and for one we are reading live off
 * another forge — the rows differ only in where they point.
 */
export function treeListing(
  base: string,
  ref: string,
  path: string,
  entries: readonly TreeEntry[],
): Html {
  const encoded = encodeURIComponent(ref);
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const rows: Html[] = [];
  if (path !== "") {
    rows.push(
      row({
        href: `${base}/tree/${encoded}${parent === "" ? "" : `/${parent}`}`,
        lead: icon("up"),
        title: html`<span class="muted">..</span>`,
        nav: true,
      }),
    );
  }
  for (const entry of entries) {
    const target = path === "" ? entry.name : `${path}/${entry.name}`;
    const isTree = entry.type === "tree";
    rows.push(
      html`<li>
        <a
          class="row tree-row"
          data-kind="${entry.type}"
          data-nav
          tabindex="-1"
          href="${base}/${isTree ? "tree" : "blob"}/${encoded}/${target}"
        >
          <span class="row-lead">${icon(isTree ? "folder" : "file")}</span>
          <span class="row-main"
            ><span class="row-title">${entry.name}</span></span
          >
          ${when(
            entry.size >= 0,
            () =>
              html`<span class="row-trail muted small num"
                >${sizeWithTokens(entry.size, target)}</span
              >`,
          )}
        </a>
      </li>`,
    );
  }
  return html`${listCard(rows)}${directoryTotal(entries)}`;
}

/**
 * What the files at this level weigh together: bytes and estimated tokens,
 * the two summed over the same files. Subdirectories carry no size in a
 * tree listing (`git ls-tree -l` gives `-`), so they are not in it — the
 * line says "here" and the tooltip says why. Binary files add bytes but no
 * tokens. Nothing when there are no files.
 */
export function directoryTotal(entries: readonly TreeEntry[]): Html {
  let files = 0;
  let bytes = 0;
  let tokens = 0;
  for (const entry of entries) {
    if (entry.type !== "blob" || entry.size < 0) continue;
    files += 1;
    bytes += entry.size;
    tokens += estimateTokens(entry.size, entry.name) ?? 0;
  }
  if (files === 0) return html``;
  return html`<p
    class="muted small num tree-total"
    title="Files at this level only; subdirectories are not counted"
  >
    ${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"} here ·
    ${fileSize(bytes)} · ${tokenCount(tokens, "estimated")}
  </p>`;
}

/**
 * The README under a directory listing, read through whichever source is
 * answering. It is found in the entries we already have rather than by asking
 * for the tree again — `RepoSource.readme` only knows the root, and a README
 * two directories down is exactly as worth rendering.
 */
export async function readmeFor(
  source: RepoSource,
  ref: string,
  entries: readonly TreeEntry[],
  prefix: string,
): Promise<Html> {
  const readme = entries.find(
    (e) =>
      e.type === "blob" && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name),
  );
  if (!readme) return html``;
  const at = prefix === "" ? readme.name : `${prefix}/${readme.name}`;
  const blob = await source.blob(ref, at);
  if (!blob.ok || blob.value.kind !== "text") return html``;
  if (blob.value.size > MAX_RENDER_BYTES) return html``;
  const text = new TextDecoder().decode(blob.value.body);
  const rendered = /\.(md|markdown)$/i.test(readme.name)
    ? renderMarkdown(text)
    : html`<pre>${text}</pre>`;
  return card(html`<div class="prose">${rendered}</div>`, {
    pad: false,
    head: html`${icon("file")}
      <h2>${readme.name}</h2>`,
  });
}

/**
 * A Markdown file has two right answers — the prose it becomes and the text
 * you would edit — so the page offers both and defaults to the one people
 * came for. `?view=source` is a plain link, so both halves work with no
 * JavaScript, are addressable, and survive being sent to somebody.
 */
export type BlobView = "source" | "rendered";

export const isMarkdownPath = (path: string): boolean =>
  /\.(md|markdown|mdx)$/i.test(path);

export function blobView(value: string | null): BlobView {
  return value === "source" ? "source" : "rendered";
}

/** One file, in each of the three states a source can hand one back in. */
export function blobBody(
  base: string,
  ref: string,
  path: string,
  blob: Blob,
): { content: Html; lines: number } {
  const encoded = encodeURIComponent(ref);
  if (blob.kind === "binary") {
    return {
      lines: 0,
      content: empty({
        icon: "file",
        title: "Binary file",
        note: `${fileSize(blob.size)} — not shown, but you can download it.`,
        action: btn("Download", {
          href: `${base}/raw/${encoded}/${path}`,
          variant: "primary",
          icon: "download",
        }),
      }),
    };
  }
  if (blob.kind === "too_large") {
    return {
      lines: 0,
      content: empty({
        icon: "alert",
        title: "Too large to render",
        note: `${fileSize(blob.size)} — over the render cap. Fetch the raw bytes instead.`,
        action: btn("View raw", {
          href: `${base}/raw/${encoded}/${path}`,
          variant: "primary",
        }),
      }),
    };
  }
  const text = new TextDecoder().decode(blob.body).replace(/\n$/, "");
  // Highlight the whole file (multi-line constructs need full context),
  // then take the first N lines for rendering.
  const highlighted = highlightBlob(text, path);
  const lines = highlighted.slice(0, MAX_RENDER_LINES);
  const truncated = highlighted.length > MAX_RENDER_LINES;
  return {
    lines: highlighted.length,
    content: html`<div class="card code">
        <table>
          ${lines.map(
            (line, i) =>
              html`<tr id="L${i + 1}">
                <td class="ln"><a href="#L${i + 1}">${i + 1}</a></td>
                <td><pre>${line}</pre></td>
              </tr>`,
          )}
        </table>
      </div>
      ${when(truncated, () =>
        empty({
          icon: "alert",
          title: "Showing the first 5,000 lines",
          note: `This file has ${highlighted.length.toLocaleString()} lines. Fetch the raw bytes for all of them.`,
          action: btn("View raw", { href: `${base}/raw/${encoded}/${path}` }),
        }),
      )}`,
  };
}

/** The ref switcher and the History link every code page carries. */
export function codeBar(
  refs: RefSet,
  ref: string,
  hrefFor: (r: string) => string,
  historyHref: string,
  menu: { base?: string; canWrite?: boolean } = {},
): Html {
  return html`${refMenu(refs, ref, hrefFor, menu)}
  ${btn("History", {
    href: historyHref,
    size: "sm",
    variant: "outline",
    icon: "history",
  })}`;
}

/**
 * The About rail: what this repo is, in one glance, plus how to clone it.
 *
 * On a mirror, everything about the origin sits in one "Where it lives"
 * block — where it comes from, when it last came, the button that fetches it
 * now, and where a push actually lands. Those four facts used to be spread
 * across three parts of the card, which is how someone ends up pushing to a
 * mirror without knowing the origin gets the last word.
 *
 * `drift` is how far the fork has slipped from its parent, read by the caller
 * (git, so asynchronous); `undefined` on anything that is not a native fork.
 */
function aboutCard(
  ctx: Ctx,
  repo: Repo,
  refs: RefSet,
  drift?: ForkDrift,
): Html {
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  // An SSH listener is not built yet; when a deployment configures one, the
  // second clone line appears with no further change here.
  const sshPort = (ctx.app.config as { sshPort?: number }).sshPort;
  const parent = forkParent(ctx, repo);
  const origin = repo.origin;
  // A fork made at the origin has no `forkParentId` — its parent is a
  // repository on another forge — so the lineage row reads it off the link
  // the fork flow wrote, and points at the live browse of the upstream.
  const upstream = repoForkOf(ctx.app.db, repo.id);
  const upstreamHref =
    upstream === null || origin === null
      ? undefined
      : browseBase(origin.originId, upstream);
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  const whereItLives = when(
    origin,
    (o) =>
      html`<div class="where-block">
        <h3>Where it lives</h3>
        <dl>
          <dt>Origin</dt>
          <dd>
            ${o.htmlUrl === ""
              ? html`${o.fullName}`
              : html`<a href="${o.htmlUrl}" rel="noreferrer noopener"
                  >${o.fullName}</a
                >`}
          </dd>
          <dt>Last fetch</dt>
          <dd>${o.lastFetchAt === null ? "never" : time(o.lastFetchAt)}</dd>
        </dl>
        ${when(
          o.fetchError !== "",
          () => html`<p class="error-note mt">${o.fetchError}</p>`,
        )}
        ${when(
          admin,
          () =>
            html`<form method="post" action="${repoBase(repo)}/sync" class="mt">
              ${btn("Sync now", { size: "sm", icon: "sync" })}
            </form>`,
        )}
        <p class="mt small muted">
          Pushes here go through to
          <span class="mono">${o.fullName}</span> first — if the origin refuses
          one, nothing lands locally either.
        </p>
      </div>`,
  );
  return html`<aside class="about">
    ${card(
      html`${when(
          repo.description !== "",
          () => html`<p class="mb">${repo.description}</p>`,
        )}
        <dl>
          <dt>Visibility</dt>
          <dd>${repo.visibility}</dd>
          <dt>Default</dt>
          <dd class="mono">${repo.defaultBranch}</dd>
          <dt>Protection</dt>
          <dd>${repo.protectDefault ? "on" : "off"}</dd>
          <dt>Branches</dt>
          <dd class="num">${refs.branches.length}</dd>
          ${when(
            refs.tags.length > 0,
            () =>
              html`<dt>Tags</dt>
                <dd class="num">${refs.tags.length}</dd>`,
          )}
          ${when(
            parent,
            (p) =>
              // The standing and the one thing to do about it live in the
              // Following card above the code; the rail only names the parent.
              html`<dt>Fork of</dt>
                <dd>
                  <a href="/${p.ownerName}/${p.name}"
                    >${p.ownerName}/${p.name}</a
                  >
                </dd>`,
          )}
          ${when(
            upstream,
            (up) =>
              html`<dt>Fork of</dt>
                <dd>
                  ${upstreamHref === undefined
                    ? html`<span class="mono">${up}</span>`
                    : html`<a href="${upstreamHref}">${up}</a>`}
                </dd>`,
          )}
        </dl>
        ${whereItLives}
        <p class="mt small muted">Clone over HTTPS</p>
        <span class="clone"
          ><span class="clone-text" id="clone-https">${cloneUrl}</span>
          ${iconBtn("copy", "Copy clone URL", {
            size: "sm",
            type: "button",
            copy: "clone-https",
          })}</span
        >
        ${when(
          sshPort !== undefined,
          () =>
            html`<p class="mt small muted">Clone over SSH</p>
              <span class="clone"
                ><span class="clone-text" id="clone-ssh"
                  >ssh://git@${ctx.app.config.host ??
                  ctx.url
                    .hostname}:${sshPort}/${repo.ownerName}/${repo.name}.git</span
                ></span
              >`,
        )}`,
      { head: html`<h2>About</h2>` },
    )}
  </aside>`;
}

// ---- pages ----

/**
 * Studio's own word for a repository it otherwise has nothing to say about:
 * no app record, so no head card, no box, no Now — just the code underneath,
 * same as it always rendered. One line says so, and the one door out —
 * `/settings/app`, the same "Run as an app" form Settings already carries —
 * opens only for whoever could actually submit it, so a reader never sees a
 * button that would just come back refused.
 */
function noAppCard(ctx: Ctx, repo: Repo): Html {
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  return empty({
    icon: "rocket",
    title: "This repository has no app yet.",
    ...(admin
      ? {
          action: btn("Run as an app", {
            href: `${repoBase(repo)}/settings/app`,
            variant: "primary",
            icon: "rocket",
          }),
        }
      : {}),
  });
}

/** The tree, the README under it, and the ref switcher above both. */
export async function renderCode(
  scope: RepoScope,
  o: {
    refs: RefSet;
    ref: string;
    path: string;
    entries: readonly TreeEntry[];
    extra?: Html;
    rail?: Html;
  },
): Promise<Html> {
  const base = scope.base;
  const { ref, path } = o;
  const readme = await readmeFor(scope.source, ref, o.entries, path);
  const historyParams = new URLSearchParams({ ref });
  if (path !== "") historyParams.set("path", path);
  const bar =
    path === ""
      ? html`<div class="bar mb">
          ${codeBar(
            o.refs,
            ref,
            (r) => `${base}?ref=${encodeURIComponent(r)}`,
            `${base}/commits?${historyParams.toString()}`,
            { base, canWrite: scope.caps.write },
          )}
          <span class="spacer"></span>
          ${finderButton()}
        </div>`
      : html`<div class="path-head">
          ${refMenu(
            o.refs,
            ref,
            (r) => `${base}/tree/${encodeURIComponent(r)}/${path}`,
            { base, canWrite: scope.caps.write },
          )}
          ${pathCrumbs(base, scope.facts.name, ref, path, false)}
          <span class="spacer"></span>
          ${btn("History", {
            href: `${base}/commits?${historyParams.toString()}`,
            size: "sm",
            variant: "outline",
            icon: "history",
          })}
        </div>`;
  const main = html`${bar} ${o.extra ?? null}
    ${treeListing(base, ref, path, o.entries)}
    <div class="mt">${readme}</div>`;
  return o.rail === undefined
    ? main
    : html`<div class="repo-layout">
        <div>${main}</div>
        ${o.rail}
      </div>`;
}

/**
 * What a file page offers besides reading it.
 *
 * Three situations, one button. On a repository we hold and may push, it is
 * Edit. On one whose origin says we may not — a live browse, or a mirror of
 * somebody else's repository — it is **Propose a change**, which is the same
 * editor with a fork and a pull request behind the button. Nothing
 * disappears, because "you cannot change this" is never the whole truth: you
 * can always propose it.
 */
export function editAction(scope: RepoScope, ref: string, path: string): Html {
  const encoded = encodeURIComponent(ref);
  if (scope.propose !== undefined) {
    return btn("Propose a change", {
      href: `${scope.base}/edit/${encoded}/${path}`,
      size: "sm",
      variant: "outline",
      icon: "fork",
      shortcut: "e",
      title: `You cannot push to ${scope.propose.upstream} — this lands on your fork and opens a pull there`,
    });
  }
  if (scope.kind === "origin") {
    const mirror = scope.mirror;
    return btn("Mirror to edit", {
      href:
        mirror === undefined
          ? scope.base
          : `/${mirror.ownerName}/${mirror.name}/edit/${encoded}/${path}`,
      size: "sm",
      variant: "outline",
      icon: mirror === undefined ? "download" : "pencil",
      title:
        mirror === undefined
          ? "This repository is read-only here. Mirror it into your workbench to edit it."
          : "Edit this file in the mirror",
    });
  }
  if (!scope.caps.write) return html``;
  return btn("Edit", {
    href: `${scope.base}/edit/${encoded}/${path}`,
    size: "sm",
    variant: "outline",
    icon: "pencil",
    shortcut: "e",
  });
}

/**
 * One file, framed by the same path header the tree uses. The header is
 * sticky and the whole pane is one element, because a script swapping a
 * preview in replaces exactly this.
 */
export function renderBlob(
  scope: RepoScope,
  o: {
    refs: RefSet;
    ref: string;
    path: string;
    blob: Blob;
    view?: BlobView;
  },
): Html {
  const base = scope.base;
  const encoded = encodeURIComponent(o.ref);
  const markdown = o.blob.kind === "text" && isMarkdownPath(o.path);
  const view: BlobView = markdown ? (o.view ?? "rendered") : "source";
  const { content, lines } =
    view === "rendered" && o.blob.kind === "text"
      ? renderedMarkdown(o.blob)
      : blobBody(base, o.ref, o.path, o.blob);
  const sizeText =
    o.blob.kind === "too_large" ? "" : sizeWithTokens(o.blob.size, o.path);
  const fileHref = `${base}/blob/${encoded}/${o.path}`;
  return html`<div class="code-pane" id="code-pane" data-path="${o.path}">
    <div class="path-head">
      ${refMenu(
        o.refs,
        o.ref,
        (r) => `${base}/blob/${encodeURIComponent(r)}/${o.path}`,
        { base, canWrite: scope.caps.write },
      )}
      ${pathCrumbs(base, scope.facts.name, o.ref, o.path, true)}
      <span class="spacer"></span>
      ${when(
        lines > 0,
        () =>
          html`<span class="muted small num"
            >${lines.toLocaleString()} lines · ${sizeText}</span
          >`,
      )}
      ${when(
        markdown,
        () =>
          html`<span class="blob-view"
            >${seg([
              {
                label: "Source",
                href: `${fileHref}?view=source`,
                current: view === "source",
              },
              {
                label: "Rendered",
                href: fileHref,
                current: view === "rendered",
              },
            ])}</span
          >`,
      )}
      ${btn("Raw", {
        href: `${base}/raw/${encoded}/${o.path}`,
        size: "sm",
        variant: "outline",
      })}
      ${btn("History", {
        href: `${base}/commits?ref=${encoded}&path=${encodeURIComponent(o.path)}`,
        size: "sm",
        variant: "outline",
        icon: "history",
      })}
      ${editAction(scope, o.ref, o.path)}
    </div>
    ${content}
  </div>`;
}

/** A Markdown file as prose, framed exactly the way a README is. */
function renderedMarkdown(blob: Blob & { kind: "text" }): {
  content: Html;
  lines: number;
} {
  const text = new TextDecoder().decode(blob.body);
  return {
    lines: text === "" ? 0 : text.replace(/\n$/, "").split("\n").length,
    content: html`<div class="card prose">${renderMarkdown(text)}</div>`,
  };
}

/** The bytes, with the headers that stop them ever executing as a page. */
export function rawResponse(blob: Blob): Response {
  if (blob.kind === "too_large") return new Response("", { status: 404 });
  return new Response(blob.body, {
    headers: {
      "content-type":
        blob.kind === "text"
          ? "text/plain; charset=utf-8"
          : "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, max-age=0",
    },
  });
}

// GET /:owner/:name — the repo home. An app's home is the app, for every
// viewer: what it serves, who is on it, what it asks; its code is one tab
// deeper, at /files. Any other repository's home is its code. An older
// `?ref=` link to the code of an app is handed on to its Files step.
export async function repoHome(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (record === undefined) return await codeHome(ctx, repo);
  if (ctx.url.searchParams.has("ref"))
    return redirect(`${repoBase(repo)}/files${ctx.url.search}`);
  return await studioApp(ctx, repo, record);
}

// GET /:owner/:name/files — an app's Files step: its code, exactly the page
// any other repository's home is. A repository that is not an app has no
// step under a home that is already its code, so it is sent there.
export async function repoFiles(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (getAppByRepo(ctx.app.db, repo.id) === undefined)
    return redirect(`${repoBase(repo)}${ctx.url.search}`);
  return await codeHome(ctx, repo);
}

/** The code at a ref: the tree, the README and the About rail — with, in
 * the studio, the offer to make a repository that is not an app one. */
async function codeHome(ctx: Ctx, repo: Repo): Promise<Response> {
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  const noApp = isApp ? null : noAppCard(ctx, repo);
  const scope = localScope(ctx, repo);
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  const refs = await refSetFrom(scope.source);

  if (refs.branches.length === 0) {
    const body = html`${scopeHeader(ctx, scope, "code")}${noApp}
      <div class="mt">
        ${empty({
          icon: "repo",
          title: "An empty repository, ready for its first push",
          note: "Point a local repository at it and push — the first branch you push becomes the code you see here.",
        })}
        ${card(
          html`<span class="clone"
            ><span class="clone-text" id="clone-https"
              >git remote add origin ${cloneUrl} &amp;&amp; git push -u origin
              ${repo.defaultBranch}</span
            >
            ${iconBtn("copy", "Copy", {
              size: "sm",
              type: "button",
              copy: "clone-https",
            })}</span
          >`,
          {
            head: html`${icon("command")}
              <h2>Get started</h2>`,
          },
        )}
      </div>`;
    return page({
      ctx,
      title: repo.name,
      description: repo.description,
      feed: {
        href: `${repoBase(repo)}/activity.atom`,
        title: `${repo.ownerName}/${repo.name} activity`,
      },
      crumbs: scope.crumbs,
      palette: scope.palette,
      body,
    });
  }

  const wanted = ctx.url.searchParams.get("ref");
  const ref =
    wanted !== null && isSafeRef(wanted) && knownRef(refs, wanted)
      ? wanted
      : knownRef(refs, repo.defaultBranch)
        ? repo.defaultBranch
        : refs.branches[0]!;
  // A fork's rail says how far its default branch is from its parent's; the
  // count is git's, so it is read here rather than inside the card — beside
  // the tree read, not after it, because neither waits on the other.
  const parent = forkParent(ctx, repo);
  const [entries, drift] = await Promise.all([
    scope.source.tree(ref, ""),
    parent === undefined ? undefined : forkDrift(ctx.app, repo, parent),
  ]);
  const tree = entries.ok ? entries.value : [];

  const following = await followingOf(ctx, repo);
  const body = html`${scopeHeader(ctx, scope, "code", {
    branchCount: refs.branches.length,
  })}${noApp}
  ${appStrip(ctx, repo)}
  ${following === undefined
    ? forkBar(ctx, repo)
    : followingCard(ctx, repo, following)}
  ${await renderCode(scope, {
    refs,
    ref,
    path: "",
    entries: tree,
    rail: aboutCard(ctx, repo, refs, drift),
  })}
  ${codeMount(scope, ref)} ${finderDialog()} ${liveMount({ repo: scope.base })}`;
  return page({
    ctx,
    title: repo.name,
    description: repo.description,
    feed: {
      href: `${repoBase(repo)}/activity.atom`,
      title: `${repo.ownerName}/${repo.name} activity`,
    },
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
    scriptJs: `${codeJs}\n${liveClientJs}`,
  });
}

function knownRef(refs: RefSet, name: string): boolean {
  return refs.branches.includes(name) || refs.tags.includes(name);
}

/**
 * The explorer's "New file" affordance, for a writer standing in a folder —
 * or, where the origin says you cannot push, its propose twin.
 */
export function newFileAction(
  scope: RepoScope,
  ref: string,
  dir: string,
): Html {
  const encoded = encodeURIComponent(ref);
  const href = `${scope.base}/new/${encoded}${dir === "" ? "" : `/${dir}`}`;
  if (scope.propose !== undefined)
    return btn("Propose a new file", {
      href,
      size: "sm",
      variant: "ghost",
      icon: "fork",
    });
  if (!scope.caps.write || scope.kind !== "local") return html``;
  return btn("New file", {
    href,
    size: "sm",
    variant: "ghost",
    icon: "filePlus",
  });
}

/**
 * The code browser's frame: the explorer column, the content beside it, and
 * the finder dialog that both the button and `t` open. Every code page —
 * ours and a live browse — goes through here, so the two can never drift.
 */
export function codePage(
  ctx: Ctx,
  scope: RepoScope,
  o: {
    title: string;
    ref: string;
    explorer: Html;
    content: Html;
    header?: Html;
    before?: Html;
  },
): Response {
  return page({
    ctx,
    title: o.title,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${o.header ?? scopeHeader(ctx, scope, "code", { compact: true })}
    ${o.before ?? null} ${codeLayout(o.explorer, o.content)}
    ${codeMount(scope, o.ref)} ${finderDialog()}`,
    scriptJs: codeJs,
    wide: true,
  });
}

// GET /:owner/:name/tree/:ref[/*path]
export async function treePage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  const entries = await scope.source.tree(ref, path);
  if (!entries.ok) return notFoundPage(ctx);

  // The explorer's lazy expansion asks for exactly one directory.
  if (ctx.url.searchParams.get("fragment") === "explorer")
    return fragment(explorerFragment(scope.base, ref, path, entries.value), {
      request: ctx.request,
    });

  const [refs, explorer] = await Promise.all([
    refSetFrom(scope.source),
    loadExplorer(scope.source, ref, path, false),
  ]);
  return codePage(ctx, scope, {
    title: `${path || ref} · ${repo.name}`,
    ref,
    explorer: explorerColumn(scope, explorer, {
      finder: true,
      actions: newFileAction(scope, ref, path),
    }),
    content: await renderCode(scope, {
      refs,
      ref,
      path,
      entries: entries.value,
    }),
  });
}

// GET /:owner/:name/blob/:ref/*path
export async function blobPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  const blob = await scope.source.blob(ref, path);
  if (!blob.ok) return notFoundPage(ctx);
  const refs = await refSetFrom(scope.source);
  const pane = renderBlob(scope, {
    refs,
    ref,
    path,
    blob: capped(blob.value),
    view: blobView(ctx.url.searchParams.get("view")),
  });

  // The preview a script drops into the pane beside the explorer. Same
  // renderer, same markup — a preview and a real page load are the same file.
  if (ctx.url.searchParams.get("fragment") === "1")
    return fragment(pane, { request: ctx.request });

  const explorer = await loadExplorer(scope.source, ref, path, true);
  const filename = path.split("/").pop() ?? path;
  return codePage(ctx, scope, {
    title: `${filename} · ${repo.name}`,
    ref,
    explorer: explorerColumn(scope, explorer, {
      finder: true,
      actions: newFileAction(
        scope,
        ref,
        path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      ),
    }),
    content: pane,
  });
}

/**
 * GET /:owner/:name/paths/:ref — every file path at a ref, as JSON, for the
 * fuzzy finder. It is the same read `RepoSource.paths` already bounds and
 * caches, behind the same `canRead` every other repo route asks: a repository
 * you cannot see does not have a path list either.
 */
export async function pathsJson(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFound();
  const scope = localScope(ctx, repo);
  const listed = await scope.source.paths(ctx.params.ref ?? "");
  if (!listed.ok) return notFound();
  return json(
    {
      ref: ctx.params.ref ?? "",
      paths: listed.value.paths,
      truncated: listed.value.truncated,
    },
    200,
    { "cache-control": "private, max-age=30" },
  );
}

/** The page's own render ceiling, under the source's fetch ceiling. */
function capped(blob: Blob): Blob {
  return blob.kind !== "too_large" && blob.size > MAX_RENDER_BYTES
    ? { kind: "too_large", size: blob.size }
    : blob;
}

/**
 * GET /:owner/:name/raw/:ref/*path — the bytes, nothing else. Served as plain
 * text (or an opaque stream for binary) with `nosniff` and a `sandbox` CSP, so
 * a file in a repository can never execute as a page on this origin.
 */
export async function rawBlob(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  if (!isSafeRef(ref) || !isSafeTreePath(path)) return notFoundPage(ctx);

  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const blob = await blobForRender(dir, ref, path, 25_000_000);
  if (blob.kind === "missing" || blob.kind === "too_large")
    return notFoundPage(ctx);
  return rawResponse(blob);
}
