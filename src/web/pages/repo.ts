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
import { getRepoById, listForks } from "../../core/repos.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import {
  blobForRender,
  commitLog,
  listRefs,
  listTree,
  type TreeEntry,
} from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  repoPalette,
  signInFirst,
} from "../chrome.ts";
import { highlightBlob } from "../code.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import {
  btn,
  card,
  crumbs,
  empty,
  fileSize,
  icon,
  iconBtn,
  listCard,
  menu,
  row,
} from "../ui.ts";

const MAX_RENDER_BYTES = 1_000_000;
// A blob under the byte cap can still be pathological (a megabyte of newlines
// is ~490k lines). Bounding rendered lines bounds the response independently.
const MAX_RENDER_LINES = 5_000;

import { pathCrumbs, refMenu, refSet, type RefSet } from "./refs.ts";

export { crumbsFor, loadRepo, repoBase };
export { pathCrumbs, refMenu, refSet } from "./refs.ts";

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

// ---- shared pieces ----

function treeListing(
  repo: Repo,
  ref: string,
  path: string,
  entries: TreeEntry[],
): Html {
  const base = repoBase(repo);
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

async function readmeSection(
  dir: string,
  ref: string,
  entries: TreeEntry[],
  prefix: string,
): Promise<Html> {
  const readme = entries.find(
    (e) =>
      e.type === "blob" && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name),
  );
  if (!readme) return html``;
  const at = prefix === "" ? readme.name : `${prefix}/${readme.name}`;
  const blob = await blobForRender(dir, ref, at, MAX_RENDER_BYTES);
  if (blob.kind !== "text") return html``;
  const text = new TextDecoder().decode(blob.body);
  const rendered = /\.(md|markdown)$/i.test(readme.name)
    ? renderMarkdown(text)
    : html`<pre>${text}</pre>`;
  return card(html`<div class="prose">${rendered}</div>`, {
    pad: false,
    head: html`${icon("file")}
      <h2>${readme.name}</h2>`,
  });
}

/** The About rail: what this repo is, in one glance, plus how to clone it. */
function aboutCard(ctx: Ctx, repo: Repo, refs: RefSet): Html {
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  // An SSH listener is not built yet; when a deployment configures one, the
  // second clone line appears with no further change here.
  const sshPort = (ctx.app.config as { sshPort?: number }).sshPort;
  const parent =
    repo.forkParentId !== null
      ? getRepoById(ctx.app.db, repo.forkParentId)
      : undefined;
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

// GET /:owner/:name — the repo home: the tree at a ref, README, About rail.
export async function repoHome(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const base = repoBase(repo);
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  const refs = await refSet(dir);

  if (refs.branches.length === 0) {
    const body = html`${repoHeader(ctx, repo, "code")}
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
      crumbs: crumbsFor(repo),
      palette: repoPalette(repo),
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
  const entries = await listTree(dir, ref, "");
  const tree = entries.ok ? entries.value : [];
  const readme = await readmeSection(dir, ref, tree, "");

  const body = html`${repoHeader(ctx, repo, "code")} ${forkBar(ctx, repo)}
    <div class="repo-layout">
      <div>
        <div class="bar mb">
          ${refMenu(refs, ref, (r) => `${base}?ref=${encodeURIComponent(r)}`)}
          ${btn("History", {
            href: `${base}/commits?ref=${encodeURIComponent(ref)}`,
            size: "sm",
            variant: "outline",
            icon: "history",
          })}
        </div>
        ${treeListing(repo, ref, "", tree)}
        <div class="mt">${readme}</div>
      </div>
      ${aboutCard(ctx, repo, refs)}
    </div>`;
  return page({
    ctx,
    title: repo.name,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
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
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  if (!isSafeRef(ref) || (path !== "" && !isSafeTreePath(path)))
    return notFoundPage(ctx);

  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const entries = await listTree(dir, ref, path);
  if (!entries.ok) return notFoundPage(ctx);
  const refs = await refSet(dir);
  const readme = await readmeSection(dir, ref, entries.value, path);
  const base = repoBase(repo);

  const body = html`${repoHeader(ctx, repo, "code", { compact: true })}
    <div class="path-head">
      ${refMenu(
        refs,
        ref,
        (r) =>
          `${base}/tree/${encodeURIComponent(r)}${path === "" ? "" : `/${path}`}`,
      )}
      ${pathCrumbs(repo, ref, path, false)}
      <span class="spacer"></span>
      ${btn("History", {
        href: `${base}/commits?ref=${encodeURIComponent(ref)}${
          path === "" ? "" : `&path=${encodeURIComponent(path)}`
        }`,
        size: "sm",
        variant: "outline",
        icon: "history",
      })}
    </div>
    ${treeListing(repo, ref, path, entries.value)}
    <div class="mt">${readme}</div>`;
  return page({
    ctx,
    title: `${path || ref} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
  });
}

// GET /:owner/:name/blob/:ref/*path
export async function blobPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  if (!isSafeRef(ref) || !isSafeTreePath(path)) return notFoundPage(ctx);

  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const blob = await blobForRender(dir, ref, path, MAX_RENDER_BYTES);
  if (blob.kind === "missing") return notFoundPage(ctx);
  const refs = await refSet(dir);
  const base = repoBase(repo);
  const encoded = encodeURIComponent(ref);

  let content: Html;
  let lineCount = 0;
  const sizeText = blob.kind === "too_large" ? "" : fileSize(blob.size);
  if (blob.kind === "binary") {
    content = empty({
      icon: "file",
      title: "Binary file",
      note: `${fileSize(blob.size)} — not shown, but you can download it.`,
      action: btn("Download", {
        href: `${base}/raw/${encoded}/${path}`,
        variant: "primary",
        icon: "download",
      }),
    });
  } else if (blob.kind === "too_large") {
    content = empty({
      icon: "alert",
      title: "Too large to render",
      note: `${fileSize(blob.size)} — over the render cap. Fetch the raw bytes instead.`,
      action: btn("View raw", {
        href: `${base}/raw/${encoded}/${path}`,
        variant: "primary",
      }),
    });
  } else {
    const text = new TextDecoder().decode(blob.body).replace(/\n$/, "");
    // Highlight the whole file (multi-line constructs need full context),
    // then take the first N lines for rendering.
    const highlighted = highlightBlob(text, path);
    lineCount = highlighted.length;
    const lines = highlighted.slice(0, MAX_RENDER_LINES);
    const truncated = highlighted.length > MAX_RENDER_LINES;
    content = html`<div class="card code">
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
      )}`;
  }

  const filename = path.split("/").pop() ?? path;
  const body = html`${repoHeader(ctx, repo, "code", { compact: true })}
    <div class="path-head">
      ${refMenu(
        refs,
        ref,
        (r) => `${base}/blob/${encodeURIComponent(r)}/${path}`,
      )}
      ${pathCrumbs(repo, ref, path, true)}
      <span class="spacer"></span>
      ${when(
        lineCount > 0,
        () =>
          html`<span class="muted small num"
            >${lineCount.toLocaleString()} lines · ${sizeText}</span
          >`,
      )}
      ${btn("Raw", {
        href: `${base}/raw/${encoded}/${path}`,
        size: "sm",
        variant: "outline",
      })}
      ${btn("History", {
        href: `${base}/commits?ref=${encoded}&path=${encodeURIComponent(path)}`,
        size: "sm",
        variant: "outline",
        icon: "history",
      })}
    </div>
    ${content}`;
  return page({
    ctx,
    title: `${filename} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    body,
  });
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
