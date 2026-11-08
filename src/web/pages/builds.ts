/**
 * Builds: the pins people made, drawn as a lineage. A pin's parent is the
 * one its person named, else the nearest pin in its history — read from git
 * (`for-each-ref --merged`), so the tree follows the work even across
 * merges and squashes that a strict commit graph would split. A fork's
 * first pins hang from its parent repository's, which its objects share.
 */

import { deletePin, pinBuild } from "../../actions/builds.ts";
import { previewBuild } from "../../actions/build_preview.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { openEnvUrl } from "../../actions/apps.ts";
import { buildLineage, type BuildNode } from "../../core/lineage.ts";
import { canWrite } from "../../core/repos.ts";
import {
  isPinLabel,
  listBuildPins,
  type BuildPin,
} from "../../git/builds.ts";
import { exactRefOid } from "../../git/branches.ts";
import { isSafeOid } from "../../git/guard.ts";
import { repoDir } from "../../git/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { backTo, field as formValue, readForm } from "../form.ts";
import { isLocalPath } from "../flash.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, field, row, selectField, time } from "../ui.ts";

/**
 * The label a new pin is offered. An iteration branch (`iter-3`) pinned
 * for the first time offers its own name, and a fork's first pin is
 * `iter-1`: each iteration is a checkpoint under the name it was made as.
 * Otherwise the newest label, stepped on by one.
 */
export function suggestLabel(pins: readonly BuildPin[], forked: boolean, source: string): string {
  const branch = /^branch (iter-\d+[A-Za-z0-9._-]*)$/.exec(source)?.[1];
  if (branch !== undefined && isPinLabel(branch) && !pins.some((p) => p.label === branch)) return branch;
  if (pins.length === 0 && forked) return "iter-1";
  return nextLabel(pins);
}

/** The newest label stepped on by one. */
export function nextLabel(pins: readonly BuildPin[]): string {
  const last = pins[0]?.label;
  if (last === undefined) return "v1";
  const letter = /^(.*\d)([a-y])$/.exec(last);
  if (letter) return `${letter[1]}${String.fromCharCode(letter[2]!.charCodeAt(0) + 1)}`;
  const num = /^(.*?)(\d+)$/.exec(last);
  if (num) return `${num[1]}${Number(num[2]) + 1}`;
  return `${last}-2`;
}

const hidden = (error: string): boolean => error === "unauthorized" || error === "not_found" || error === "forbidden";

// GET /:owner/:name/builds — the pins as a lineage, each under the one it grew from.
export async function buildsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const nodes = await buildLineage(ctx, repo);
  const writer = ctx.auth.user !== undefined && canWrite(ctx.app.db, repo, ctx.auth.user);
  const isApp = getAppByRepo(ctx.app.db, repo.id) !== undefined;
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    ${buildsList(base, nodes, writer, writer && isApp, writer)}`;
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: `Builds · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body, styleCss: BUILDS_CSS }),
  );
}

// POST /:owner/:name/builds/:label/delete — behind /-/confirm.
export async function deletePinSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const gone = await deletePin(ctx.app, ctx.auth.user, repo, ctx.params.label ?? "");
  if (!gone.ok && hidden(gone.error)) return notFoundPage(ctx);
  const to = backTo(form, `${repoBase(repo)}/builds`);
  return flashTo(ctx, to, gone.ok ? { message: `Deleted pin ${gone.value.label}.` } : { tone: "danger", message: "Delete failed." });
}

export function buildsList(
  base: string,
  nodes: readonly BuildNode[],
  canPin: boolean,
  /** Whether each pin of this repository offers Preview now: a writer, on an app. */
  canPreview = false,
  /** Whether each pin of this repository offers Delete: a writer. */
  canDelete = false,
): Html {
  return html`<h2 class="mt">Builds</h2>
    <p class="small builds-links">
      ${when(canPin, () => html`<a href="${base}/builds/new">Pin a build</a>`)}
      ${when(nodes.length > 0, () => html`<a href="${base}/iterations?layout=tree">Iterations</a>`)}
    </p>
    ${nodes.length === 0
      ? html`<p class="muted">No builds yet.${canPin ? html` Pin one from <a href="${base}/branches">a branch</a> to make it.` : null}</p>`
      : html`<ul class="list builds">${nodes.map((n) => buildRow(base, n, canPreview, canDelete))}</ul>`}`;
}

/** One pin: its label is the one accent link; the rest is quiet, in the trail. */
function buildRow(base: string, n: BuildNode, canPreview: boolean, canDelete: boolean): Html {
  const own = n.from === undefined;
  const label = encodeURIComponent(n.pin.label);
  const note = n.pin.note === n.pin.label ? "" : `${n.pin.note} · `;
  return row({
    title: html`${when(n.edge === "concept", () => html`<span class="build-concept" title="Concept edge: parent set by hand, not by commit history">┄ </span>`)}<a class="mono" href="${own ? base : `/${n.from}`}/commit/${n.pin.oid}">${n.from === undefined ? null : html`<span class="muted">${n.from}:</span>`}${n.pin.label}</a>`,
    meta: html`${note}${n.pin.source} · ${n.pin.pinnedBy} · ${time(n.pin.pinnedAt)}`,
    data: { depth: String(Math.min(n.depth, 8)) },
    trail: html`${when(
        own && n.pin.demo?.launch === "file",
        () => html`<a class="small" href="${base}/builds/${label}/cart" title="Play the captured page of ${n.pin.demo?.name ?? ""}">▶ ${n.pin.demo?.name ?? ""} ${n.pin.demo?.version ?? ""}</a>`,
      )}
      ${when(own, () => html`<a class="small" href="${base}/builds/${label}/shots">Screenshots</a>`)}
      ${when(
        canPreview && own,
        () => html`<form method="post" action="${base}/builds/preview" class="build-preview">
          <input type="hidden" name="sha" value="${n.pin.oid}" />
          ${btn("Preview", { size: "sm", variant: "link", label: `Preview build ${n.pin.label}` })}
        </form>`,
      )}
      ${when(
        canDelete && own,
        () => html`<a class="small build-del" href="/-/confirm?to=${encodeURIComponent(`${base}/builds/${label}/delete`)}" aria-label="Delete pin ${n.pin.label}">Delete</a>`,
      )}`,
  });
}

export const BUILDS_CSS = `
${[1, 2, 3, 4, 5, 6, 7, 8].map((d) => `.builds > li[data-depth="${d}"]{padding-left:${d * 20}px}`).join("\n")}
.builds .row-meta{white-space:normal;overflow-wrap:anywhere}
.builds .row-trail{flex:0 1 auto;flex-wrap:wrap;gap:4px 12px;align-items:center}
.build-concept{color:var(--muted-fg)}
.build-preview{margin:0}
.build-preview .btn{color:var(--muted-fg);font-size:inherit}
.build-preview .btn:hover,.build-preview .btn:focus-visible{color:var(--accent)}
.builds .row-trail a,.builds-links a{color:var(--muted-fg)}
.builds .row-trail a:hover,.builds .row-trail a:focus-visible,.builds-links a:hover,.builds-links a:focus-visible{color:var(--accent)}
.builds .row-trail a.build-del:hover,.builds .row-trail a.build-del:focus-visible{color:var(--danger)}
.builds-links{display:flex;gap:12px;margin:0 0 8px}
@media (max-width:719px){.builds .row{flex-wrap:wrap}.builds .row-trail{flex:1 1 100%;justify-content:flex-start}}
`;

// GET /:owner/:name/builds/new?sha=&source= — the pin form.
export async function newBuildPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  const base = repoBase(repo);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const pins = await listBuildPins(dir);
  const family = await buildLineage(ctx, repo);
  // From Pin a build with nothing chosen: the default branch's tip.
  const asked = ctx.url.searchParams.get("sha") ?? "";
  const want = isSafeOid(asked)
    ? asked
    : ((await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`)) ?? "");
  const source =
    ctx.url.searchParams.get("source") ?? (isSafeOid(asked) ? "" : `branch ${repo.defaultBranch}`);
  // From the build graph: back to it, not to Branches.
  const askedBack = ctx.url.searchParams.get("back") ?? "";
  const back = isLocalPath(askedBack) ? askedBack : undefined;
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <h1 class="mt">Pin a build</h1>
    <div class="narrow-wide mt">
      <form method="post" action="${base}/builds">
        ${field({ label: "Commit", name: "sha", value: isSafeOid(want) ? want : "", required: true, mono: true, hint: "Full commit SHA." })}
        <input type="hidden" name="source" value="${source}" />
        ${when(back, (b) => html`<input type="hidden" name="back" value="${b}" />`)}
        ${field({ label: "Label", name: "label", value: suggestLabel(pins, repo.forkParentId !== null, source), required: true, mono: true, hint: "Letters, digits, dot, dash or underscore. Example: iter-3, v3." })}
        ${field({ label: "Note", name: "note", type: "textarea", rows: 3, hint: "Optional." })}
        ${selectField({
          label: "Parent",
          name: "parent",
          hint: "Automatic: the nearest pin in the commit history. A pin in another repository creates a concept edge.",
          options: [
            { value: "", label: "Automatic", selected: true },
            // Any pin of the family: one in another repository is a
            // concept edge, an idea shared without history.
            ...family.map((n) => {
              const value = n.from === undefined ? n.pin.label : `${n.from}:${n.pin.label}`;
              return { value, label: value };
            }),
          ],
        })}
        <div class="form-actions">
          ${btn("Pin build", { variant: "primary", icon: "pin" })}
          ${btn("Cancel", { href: back ?? `${base}/branches`, variant: "link" })}
        </div>
      </form>
    </div>`;
  return timePhase(ctx.request, "render", () =>
    page({
      ctx,
      title: `Pin a build · ${repo.name}`,
      crumbs: crumbsFor(repo),
      palette: repoPalette(ctx, repo),
      body,
    }),
  );
}

const PIN_ERRORS: Record<string, string> = {
  invalid_label: "Invalid label. Use letters, digits, dot, dash or underscore, up to 40 characters.",
  invalid_parent: "Parent is not a pin in this repository.",
  not_a_commit: "Commit not found in this repository.",
  exists: "A pin with that label already exists.",
  mirrored: "This repository is a mirror. Pin builds in a fork.",
  git_failed: "Pin failed: git refused the ref.",
};

// POST /:owner/:name/builds — pin it.
export async function pinBuildSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const base = repoBase(repo);
  const pinned = await pinBuild(ctx.app, ctx.auth.user, repo, {
    label: formValue(form, "label"),
    oid: formValue(form, "sha"),
    note: formValue(form, "note"),
    parent: formValue(form, "parent"),
    source: formValue(form, "source") || "commit",
  });
  if (!pinned.ok) {
    if (pinned.error === "unauthorized" || pinned.error === "not_found" || pinned.error === "forbidden")
      return notFoundPage(ctx);
    return flashTo(ctx, `${base}/builds/new?sha=${encodeURIComponent(formValue(form, "sha"))}`, {
      tone: "danger",
      message: PIN_ERRORS[pinned.error] ?? "Pin failed.",
    });
  }
  const said = `Pinned ${pinned.value.label} at ${pinned.value.oid.slice(0, 7)}.`;
  // On Iterations, the new pin is picked.
  const to = backTo(form, `${base}/iterations?build=${encodeURIComponent(`${repo.ownerName}/${repo.name}:${pinned.value.label}`)}`);
  return flashTo(ctx, to, { message: said });
}

const PREVIEW_ERRORS: Record<string, string> = {
  unverified: "Verify your email before previewing a build.",
  mirrored: "This repository is a mirror. Preview builds in a fork.",
  not_a_commit: "Commit not found in this repository.",
  no_runtime: "Apps are disabled on this forge.",
};

export async function previewBuildSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const preview = await previewBuild(ctx.app, ctx.auth.user, repo, formValue(form, "sha"));
  if (!preview.ok) {
    // A reader is told what a stranger is; an agent never holds a session.
    if (preview.error === "unauthorized" || preview.error === "not_found" || preview.error === "forbidden")
      return notFoundPage(ctx);
    return flashTo(ctx, `${repoBase(repo)}/branches`, {
      tone: "danger",
      message: PREVIEW_ERRORS[preview.error] ?? "Preview failed.",
    });
  }
  const path = "/";
  // Through the forge's own opener, so a private app's preview gets its
  // grant; a public one's is the plain address.
  const opened = openEnvUrl(ctx.app, ctx.auth.user, repo, preview.value.env, path);
  const url = opened.ok
    ? opened.value
    : path === "/"
      ? preview.value.url
      : preview.value.url.replace(/\/$/, "") + path;
  // Not a redirect: a form's redirect to another origin is held to the
  // page's CSP form-action, which allows only the forge. A page that moves
  // itself on by script is a navigation, and the app's own address opens. The proxy
  // there shows a page that refreshes itself until the build is up.
  const short = formValue(form, "sha").slice(0, 7);
  return page({
    ctx,
    title: `Opening ${short} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    scriptJs: `location.replace(${JSON.stringify(url).replace(/</g, "\\u003c")});`,
    body: html`<h2 class="mt">Opening preview</h2>
      <p>Starting build <span class="mono">${short}</span>.</p>
      <p><a class="btn" data-variant="primary" href="${url}">Open ${url}</a></p>`,
  });
}
