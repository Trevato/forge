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
import { btn, card, field, icon, selectField, sha, time } from "../ui.ts";

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

/** The lineage as a card: one line per pin, indented under its parent. */
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
    <div class="mt">${buildsCard(base, nodes, writer, writer && isApp, writer)}</div>`;
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

export function buildsCard(
  base: string,
  nodes: readonly BuildNode[],
  canPin: boolean,
  /** Whether each pin of this repository offers Preview now: a writer, on an app. */
  canPreview = false,
  /** Whether each pin of this repository offers Delete: a writer. */
  canDelete = false,
): Html {
  return card(
    nodes.length === 0
      ? html`<p class="muted small builds-none">No pinned builds</p>`
      : html`<ol class="builds">
          ${nodes.map(
            (n) => html`<li data-depth="${String(Math.min(n.depth, 8))}" class="build-row">
              ${when(n.edge === "concept", () => html`<span class="build-concept" title="Concept edge: parent set by hand, not by commit history">┄</span>`)}
              <span class="build-label mono">${n.from === undefined ? null : html`<span class="muted">${n.from}:</span>`}${n.pin.label}</span>
              ${sha(n.pin.oid, `${n.from === undefined ? base : `/${n.from}`}/commit/${n.pin.oid}`)}
              <span class="build-note truncate" title="${n.pin.note}">${n.pin.note === n.pin.label ? "" : n.pin.note}</span>
              <span class="muted small build-meta"
                >${n.pin.source} · ${n.pin.pinnedBy} · ${time(n.pin.pinnedAt)}</span
              >
              ${when(
                n.from === undefined && n.pin.demo?.launch === "file",
                () => html`<a class="build-cart small" href="${base}/builds/${encodeURIComponent(n.pin.label)}/cart" title="Play the captured page of ${n.pin.demo?.name ?? ""}"
                  >▶ ${n.pin.demo?.name ?? ""} ${n.pin.demo?.version ?? ""}</a
                >`,
              )}
              ${when(
                canPreview && n.from === undefined,
                () => html`<form method="post" action="${base}/builds/preview" class="build-preview">
                  <input type="hidden" name="sha" value="${n.pin.oid}" />
                  ${btn("Preview now", { size: "sm", variant: "ghost", icon: "eye" })}
                </form>`,
              )}
              ${when(
                canDelete && n.from === undefined,
                () => btn("Delete", {
                  href: `/-/confirm?to=${encodeURIComponent(`${base}/builds/${encodeURIComponent(n.pin.label)}/delete`)}`,
                  size: "sm",
                  variant: "danger",
                  label: `Delete pin ${n.pin.label}`,
                }),
              )}
            </li>`,
          )}
        </ol>`,
    {
      head: html`${icon("pin")}
        <h2>Builds</h2>
        <span class="spacer"></span>
        ${when(nodes.length > 0, () => btn("Iterations", { href: `${base}/iterations?layout=tree`, size: "sm", variant: "ghost", icon: "map" }))}
        ${when(canPin, () =>
          html`${btn("Pin a build", {
            href: `${base}/builds/new`,
            size: "sm",
            icon: "plus",
          })}`,
        )}`,
      extra: "builds-card",
    },
  );
}

export const BUILDS_CSS = `
.builds{list-style:none;margin:0;padding:6px 12px}
.build-row{display:flex;align-items:center;gap:8px;min-height:30px;min-width:0}
${[1, 2, 3, 4, 5, 6, 7, 8].map((d) => `.build-row[data-depth="${d}"]{padding-left:${d * 20}px}`).join("\n")}
.build-row + .build-row{border-top:1px solid var(--border)}
.build-label{font-weight:600;flex:none}
.build-concept{color:var(--muted-fg);flex:none}
.build-note{min-width:0;flex:1}
.build-meta{flex:none;margin-left:auto}
.build-preview{flex:none;margin:0}
.builds-none{padding:10px 14px;margin:0}
@media (max-width:640px){.build-meta{display:none}}
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
    <div class="mt">
      ${card(
        html`<form method="post" action="${base}/builds" class="stack">
          ${field({ label: "Commit", name: "sha", value: isSafeOid(want) ? want : "", required: true, mono: true, hint: "Full commit SHA." })}
          <input type="hidden" name="source" value="${source}" />
          ${when(back, (b) => html`<input type="hidden" name="back" value="${b}" />`)}
          ${field({ label: "Label", name: "label", value: suggestLabel(pins, repo.forkParentId !== null, source), required: true, mono: true, hint: "Letters, digits, dot, dash or underscore. Example: iter-3, v3." })}
          ${field({ label: "Note", name: "note", rows: 3, hint: "Optional." })}
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
          <div class="bar">
            ${btn("Pin build", { variant: "primary", icon: "pin" })}
            ${btn("Cancel", { href: back ?? `${base}/branches`, variant: "ghost" })}
          </div>
        </form>`,
        {
          head: html`${icon("pin")}
            <h2>Pin a build</h2>`,
        },
      )}
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
    body: html`<div class="mt">
      ${card(
        html`<p>Starting build <span class="mono">${short}</span>.</p>
          <p><a class="btn" data-variant="primary" href="${url}">Open ${url}</a></p>`,
        { head: html`${icon("eye")}<h2>Opening preview</h2>` },
      )}
    </div>`,
  });
}
