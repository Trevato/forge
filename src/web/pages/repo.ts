/**
 * Repository pages: code at a ref, a file, the history. Everything is
 * URL-addressable and renders without JavaScript. Reads go straight to git;
 * nothing shown here is stored anywhere else.
 */

import type { Repo } from "../../core/repos.ts";
import { canRead, getRepo } from "../../core/repos.ts";
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
import { html, raw, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";

const MAX_RENDER_BYTES = 1_000_000;
// A blob under the byte cap can still be pathological (a megabyte of newlines
// is ~490k lines). Bounding rendered lines bounds the response independently.
const MAX_RENDER_LINES = 5_000;

function notFoundPage(ctx: Ctx): Response {
  return page(
    {
      title: "Not found",
      user: ctx.auth.user,
      body: html`<div class="empty">
        <h1>404</h1>
        <p class="muted">Nothing here.</p>
      </div>`,
    },
    404,
  );
}

function loadRepo(ctx: Ctx): Repo | undefined {
  const repo = getRepo(
    ctx.app.db,
    ctx.params.owner ?? "",
    (ctx.params.name ?? "").replace(/\.git$/, ""),
  );
  if (!repo || !canRead(repo, ctx.auth.user)) return undefined;
  return repo;
}

function crumbsFor(repo: Repo): { label: string; href: string }[] {
  return [
    { label: repo.ownerName, href: `/${repo.ownerName}` },
    { label: repo.name, href: `/${repo.ownerName}/${repo.name}` },
  ];
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function repoNav(repo: Repo, active: "code" | "commits"): Html {
  const base = `/${repo.ownerName}/${repo.name}`;
  return html`<div class="page-head">
    <h1><a href="${base}">${repo.name}</a></h1>
    <span class="badge">${repo.visibility}</span>
    <span class="spacer"></span>
    <a
      class="btn"
      data-size="sm"
      href="${base}"
      ${active === "code" ? raw('aria-current="page"') : null}
      >Code</a
    >
    <a
      class="btn"
      data-size="sm"
      href="${base}/commits"
      ${active === "commits" ? raw('aria-current="page"') : null}
      >Commits</a
    >
  </div>`;
}

function treeListing(
  repo: Repo,
  ref: string,
  path: string,
  entries: TreeEntry[],
): Html {
  const base = `/${repo.ownerName}/${repo.name}`;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return html`<div class="card tree">
    <ul class="list">
      ${when(
        path !== "",
        () =>
          html`<li>
            <a
              class="row"
              href="${base}${parent === ""
                ? `/tree/${ref}`
                : `/tree/${ref}/${parent}`}"
            >
              <span class="icon">←</span><span class="grow muted">..</span>
            </a>
          </li>`,
      )}
      ${entries.map((entry) => {
        const target = path === "" ? entry.name : `${path}/${entry.name}`;
        const href =
          entry.type === "tree"
            ? `${base}/tree/${ref}/${target}`
            : `${base}/blob/${ref}/${target}`;
        return html`<li>
          <a class="row" href="${href}">
            <span class="icon">${entry.type === "tree" ? "▸" : "·"}</span>
            <span class="grow">${entry.name}</span>
            ${when(
              entry.size >= 0,
              () =>
                html`<span class="muted small"
                  >${formatSize(entry.size)}</span
                >`,
            )}
          </a>
        </li>`;
      })}
    </ul>
  </div>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readmeSection(
  dir: string,
  ref: string,
  entries: TreeEntry[],
): Promise<Html> {
  const readme = entries.find(
    (e) => e.type === "blob" && /^readme(\.md)?$/i.test(e.name),
  );
  if (!readme) return html``;
  const blob = await blobForRender(dir, ref, readme.name, MAX_RENDER_BYTES);
  if (blob.kind !== "text") return html``;
  const text = new TextDecoder().decode(blob.body);
  const rendered = /\.md$/i.test(readme.name)
    ? renderMarkdown(text)
    : html`<pre>${text}</pre>`;
  return html`<div class="card md">${rendered}</div>`;
}

// GET /:owner/:name — the repo home: tree at the default branch + README.
export async function repoHome(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;

  const refs = await listRefs(dir, "refs/heads/");
  if (!refs.ok || refs.value.length === 0) {
    const body = html`${repoNav(repo, "code")}
      <div class="card empty">
        <p>An empty repository, ready for its first push.</p>
      </div>
      <div class="card clone mt">
        git remote add origin ${cloneUrl} && git push -u origin
        ${repo.defaultBranch}
      </div>`;
    return page({
      title: repo.name,
      user: ctx.auth.user,
      crumbs: crumbsFor(repo),
      body,
    });
  }

  const ref = repo.defaultBranch;
  const entries = await listTree(dir, ref, "");
  const tree = entries.ok ? entries.value : [];
  const readme = await readmeSection(dir, ref, tree);

  const body = html`${repoNav(repo, "code")}
    ${when(
      repo.description !== "",
      () => html`<p class="muted mb">${repo.description}</p>`,
    )}
    <div class="card clone">${cloneUrl}</div>
    <div class="mt">${treeListing(repo, ref, "", tree)}</div>
    <div class="mt">${readme}</div>`;
  return page({
    title: repo.name,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body,
  });
}

// GET /:owner/:name/tree/:ref/*path
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
  const readme = await readmeSection(dir, ref, entries.value);

  const body = html`${repoNav(repo, "code")}
    <p class="muted small mono mb">${ref} / ${path}</p>
    ${treeListing(repo, ref, path, entries.value)}
    <div class="mt">${readme}</div>`;
  return page({
    title: `${path || ref} · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
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

  let content: Html;
  if (blob.kind === "binary") {
    content = html`<div class="card empty">
      Binary file · ${formatSize(blob.size)}
    </div>`;
  } else if (blob.kind === "too_large") {
    content = html`<div class="card empty">
      Too large to render · ${formatSize(blob.size)}
    </div>`;
  } else {
    const all = new TextDecoder()
      .decode(blob.body)
      .replace(/\n$/, "")
      .split("\n");
    const lines = all.slice(0, MAX_RENDER_LINES);
    const truncated = all.length > MAX_RENDER_LINES;
    content = html`<div class="card code">
        <table>
          ${lines.map(
            (line, i) =>
              html`<tr id="L${i + 1}">
                <td class="ln"><a href="#L${i + 1}">${i + 1}</a></td>
                <td><pre>${line || " "}</pre></td>
              </tr>`,
          )}
        </table>
      </div>
      ${when(
        truncated,
        () =>
          html`<div class="card empty mt">
            Showing the first ${MAX_RENDER_LINES.toLocaleString()} of
            ${all.length.toLocaleString()} lines.
          </div>`,
      )}`;
  }

  const filename = path.split("/").pop() ?? path;
  const body_ = html`${repoNav(repo, "code")}
    <p class="muted small mono mb">${ref} / ${path}</p>
    ${content}`;
  return page({
    title: `${filename} · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body: body_,
  });
}

// GET /:owner/:name/commits
export async function commitsPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);

  // Clamp hard: Infinity/1e300/NaN all collapse to page 1, never a bogus skip.
  const requested = Math.floor(Number(ctx.url.searchParams.get("page")));
  const pageNum = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), 100_000)
    : 1;
  const perPage = 30;
  const log = await commitLog(dir, repo.defaultBranch, {
    limit: perPage + 1,
    skip: (pageNum - 1) * perPage,
  });
  if (!log.ok) {
    return page({
      title: `Commits · ${repo.name}`,
      user: ctx.auth.user,
      crumbs: crumbsFor(repo),
      body: html`${repoNav(repo, "commits")}
        <div class="card empty">No commits yet.</div>`,
    });
  }

  const commits = log.value.slice(0, perPage);
  const hasMore = log.value.length > perPage;
  const base = `/${repo.ownerName}/${repo.name}`;

  const body = html`${repoNav(repo, "commits")}
    <div class="card">
      <ul class="list">
        ${commits.map(
          (commit) =>
            html`<li>
              <div class="row">
                <span class="grow">
                  <strong>${commit.subject}</strong>
                  <br />
                  <span class="muted small"
                    >${commit.author} · ${timeAgo(commit.date)}</span
                  >
                </span>
                <span class="mono muted small">${commit.oid.slice(0, 8)}</span>
              </div>
            </li>`,
        )}
      </ul>
    </div>
    <div class="form-actions">
      ${when(
        pageNum > 1,
        () =>
          html`<a
            class="btn"
            data-size="sm"
            href="${base}/commits?page=${pageNum - 1}"
            >Newer</a
          >`,
      )}
      ${when(
        hasMore,
        () =>
          html`<a
            class="btn"
            data-size="sm"
            href="${base}/commits?page=${pageNum + 1}"
            >Older</a
          >`,
      )}
    </div>`;
  return page({
    title: `Commits · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body,
  });
}
