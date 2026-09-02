/**
 * Repository pages: the code at a ref, one file, and the raw bytes.
 * Everything is URL-addressable and renders without JavaScript; reads go
 * straight to git, so nothing shown here is stored anywhere else.
 *
 * Every ref reaching git passes `isSafeRef` first, and every ref *leaving*
 * here in a URL is percent-encoded, so a branch called `feature/a` stays one
 * path segment and can never smuggle a path of its own.
 */

import type { Repo } from "../../core/repos.ts";
import { forkRepo } from "../../actions/repos.ts";
import { pinRepo, syncRepoNow, unpinRepo } from "../../actions/origins.ts";
import { canAdmin, getRepoById, listForks } from "../../core/repos.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import { blobForRender, type TreeEntry } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import type { Blob, RepoSource } from "../../view/source.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  scopeHeader,
  signInFirst,
} from "../chrome.ts";
import { highlightBlob } from "../code.ts";
import { field, readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { localScope, type RepoScope } from "../scope.ts";
import {
  btn,
  card,
  empty,
  fileSize,
  icon,
  iconBtn,
  listCard,
  row,
  time,
} from "../ui.ts";

const MAX_RENDER_BYTES = 1_000_000;
// A blob under the byte cap can still be pathological (a megabyte of newlines
// is ~490k lines). Bounding rendered lines bounds the response independently.
const MAX_RENDER_LINES = 5_000;

import { pathCrumbs, refMenu, refSetFrom, type RefSet } from "./refs.ts";

export { crumbsFor, loadRepo, repoBase };
export { pathCrumbs, refMenu, refSet, refSetFrom } from "./refs.ts";

// ---- fork ----

/** The "forked from …" lineage line and a Fork button, for the repo home. */
function forkBar(ctx: Ctx, repo: Repo): Html {
  const canFork =
    ctx.auth.user !== undefined && ctx.auth.user.id !== repo.ownerId;
  const forkCount = listForks(ctx.app.db, repo.id).length;
  if (!canFork && forkCount === 0) return html``;
  return html`<div class="fork-bar">
    ${when(
      forkCount > 0,
      () =>
        html`<span class="muted small"
          >${icon("fork")} ${forkCount} fork${forkCount === 1 ? "" : "s"}</span
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

/** The page the form was submitted from, when it is one of ours. */
function safeBack(ctx: Ctx): string | undefined {
  const referer = ctx.request.headers.get("referer");
  if (referer === null) return undefined;
  const parsed = URL.parse(referer);
  if (!parsed || parsed.origin !== ctx.url.origin) return undefined;
  return parsed.pathname + parsed.search;
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
                >${fileSize(entry.size)}</span
              >`,
          )}
        </a>
      </li>`,
    );
  }
  return listCard(rows);
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
): Html {
  return html`${refMenu(refs, ref, hrefFor)}
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
 */
function aboutCard(ctx: Ctx, repo: Repo, refs: RefSet): Html {
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  // An SSH listener is not built yet; when a deployment configures one, the
  // second clone line appears with no further change here.
  const sshPort = (ctx.app.config as { sshPort?: number }).sshPort;
  const parent =
    repo.forkParentId !== null
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;
  const origin = repo.origin;
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
              html`<dt>Fork of</dt>
                <dd>
                  <a href="/${p.ownerName}/${p.name}"
                    >${p.ownerName}/${p.name}</a
                  >
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
                  >ssh://git@${ctx.url
                    .hostname}:${sshPort}/${repo.ownerName}/${repo.name}.git</span
                ></span
              >`,
        )}`,
      { head: html`<h2>About</h2>` },
    )}
  </aside>`;
}

// ---- pages ----

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
          )}
        </div>`
      : html`<div class="path-head">
          ${refMenu(
            o.refs,
            ref,
            (r) => `${base}/tree/${encodeURIComponent(r)}/${path}`,
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

/** One file, framed by the same path header the tree uses. */
export function renderBlob(
  scope: RepoScope,
  o: { refs: RefSet; ref: string; path: string; blob: Blob },
): Html {
  const base = scope.base;
  const encoded = encodeURIComponent(o.ref);
  const { content, lines } = blobBody(base, o.ref, o.path, o.blob);
  const sizeText = o.blob.kind === "too_large" ? "" : fileSize(o.blob.size);
  return html`<div class="path-head">
      ${refMenu(
        o.refs,
        o.ref,
        (r) => `${base}/blob/${encodeURIComponent(r)}/${o.path}`,
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
    </div>
    ${content}`;
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

// GET /:owner/:name — the repo home: the tree at a ref, README, About rail.
export async function repoHome(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  const refs = await refSetFrom(scope.source);

  if (refs.branches.length === 0) {
    const body = html`${scopeHeader(ctx, scope, "code")}
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
  const entries = await scope.source.tree(ref, "");
  const tree = entries.ok ? entries.value : [];

  const body = html`${scopeHeader(ctx, scope, "code")} ${forkBar(ctx, repo)}
  ${await renderCode(scope, {
    refs,
    ref,
    path: "",
    entries: tree,
    rail: aboutCard(ctx, repo, refs),
  })}`;
  return page({
    ctx,
    title: repo.name,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
}

function knownRef(refs: RefSet, name: string): boolean {
  return refs.branches.includes(name) || refs.tags.includes(name);
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
  const refs = await refSetFrom(scope.source);

  const body = html`${scopeHeader(ctx, scope, "code", { compact: true })}
  ${await renderCode(scope, {
    refs,
    ref,
    path,
    entries: entries.value,
  })}`;
  return page({
    ctx,
    title: `${path || ref} · ${repo.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
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

  const filename = path.split("/").pop() ?? path;
  const body = html`${scopeHeader(ctx, scope, "code", { compact: true })}
  ${renderBlob(scope, { refs, ref, path, blob: capped(blob.value) })}`;
  return page({
    ctx,
    title: `${filename} · ${repo.name}`,
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
  });
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
