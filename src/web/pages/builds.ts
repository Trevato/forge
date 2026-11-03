/**
 * Builds: the pins people made (`git/builds.ts`), a short form to make one,
 * and "preview now" for any commit. A pin is a git ref, so pinning runs no
 * check and wakes no agent.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { previewBuild } from "../../actions/build_preview.ts";
import { openEnvUrl } from "../../actions/apps.ts";
import { deletePin, pinBuild } from "../../actions/builds.ts";
import { canWrite } from "../../core/repos.ts";
import { exactRefOid } from "../../git/branches.ts";
import { listBuildPins, type BuildPin } from "../../git/builds.ts";
import { isSafeOid } from "../../git/guard.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette, signInFirst } from "../chrome.ts";
import { field as formValue, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, card, field, icon, sha, time } from "../ui.ts";

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

/** Renders a page and names `session` and `render` in Server-Timing. */
function timedPage(ctx: Ctx, opts: Parameters<typeof page>[0]): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const started = performance.now();
  const response = page(opts);
  notePhase(ctx.request, "render", performance.now() - started);
  return response;
}

// GET /:owner/:name/builds — the pins, newest first.
export async function buildsPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const base = repoBase(repo);
  const pins = await listBuildPins(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name));
  const writer = ctx.auth.user !== undefined && canWrite(ctx.app.db, repo, ctx.auth.user);
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <div class="mt">
      ${card(
        pins.length === 0
          ? html`<p class="muted builds-none">No builds pinned yet.</p>`
          : html`<ul class="list">
              ${pins.map(
                (p) => html`<li>
                  <div class="row build-row">
                    <span class="row-lead">${icon("pin")}</span>
                    <span class="row-main">
                      <span class="row-title mono">${p.label}</span>
                      <span class="row-meta"
                        >${sha(p.oid, `${base}/commit/${p.oid}`)} · ${p.source} · pinned ${time(p.pinnedAt)} by
                        ${p.pinnedBy}${when(p.parent, (parent) => html` · under ${parent}`)}${when(
                          p.note,
                          (note) => html` · ${note}`,
                        )}</span
                      >
                    </span>
                    <span class="row-trail">
                      ${when(writer, () =>
                        html`<form method="post" action="${base}/builds/preview" class="build-preview">
                          <input type="hidden" name="sha" value="${p.oid}" />
                          ${btn("Preview", { type: "submit", size: "sm", variant: "outline", icon: "eye" })}
                        </form>`,
                      )}
                      ${when(writer, () =>
                        btn("Delete", {
                          href: `/-/confirm?to=${encodeURIComponent(`${base}/builds/${encodeURIComponent(p.label)}/delete`)}`,
                          size: "sm",
                          variant: "danger",
                          label: `Delete pin ${p.label}`,
                        }),
                      )}
                    </span>
                  </div>
                </li>`,
              )}
            </ul>`,
        {
          head: html`${icon("pin")}
            <h2>Builds</h2>
            ${when(writer, () => btn("Pin a build", { href: `${base}/builds/new`, size: "sm", variant: "primary" }))}`,
        },
      )}
    </div>`;
  return timedPage(ctx, { ctx, title: `Builds · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
}

// GET /:owner/:name/builds/new?sha=&source= — the pin form.
export async function newBuildPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  if (!canWrite(ctx.app.db, repo, ctx.auth.user)) return notFoundPage(ctx);
  const base = repoBase(repo);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const pins = await listBuildPins(dir);
  const asked = ctx.url.searchParams.get("sha") ?? "";
  const want = isSafeOid(asked) ? asked : ((await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`)) ?? "");
  const source = ctx.url.searchParams.get("source") ?? (isSafeOid(asked) ? "" : `branch ${repo.defaultBranch}`);
  const body = html`${repoHeader(ctx, repo, "branches", { compact: true })}
    <div class="mt">
      ${card(
        html`<form method="post" action="${base}/builds" class="stack">
          ${field({ label: "Commit", name: "sha", value: isSafeOid(want) ? want : "", required: true, mono: true, hint: "Full commit SHA." })}
          <input type="hidden" name="source" value="${source}" />
          ${field({ label: "Label", name: "label", value: nextLabel(pins), required: true, mono: true, hint: "Letters, digits, dot, dash or underscore. Example: v3." })}
          ${field({ label: "Note", name: "note", rows: 3, hint: "Optional." })}
          <div class="bar">
            ${btn("Pin build", { variant: "primary", icon: "pin" })}
            ${btn("Cancel", { href: `${base}/builds`, variant: "ghost" })}
          </div>
        </form>`,
        { head: html`${icon("pin")}<h2>Pin a build</h2>` },
      )}
    </div>`;
  return timedPage(ctx, { ctx, title: `Pin a build · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
}

const PIN_ERRORS: Record<string, string> = {
  invalid_label: "Invalid label. Use letters, digits, dot, dash or underscore, up to 40 characters.",
  invalid_parent: "Parent is not a pin in this repository.",
  not_a_commit: "Commit not found in this repository.",
  exists: "A pin with that label already exists.",
  mirrored: "This repository is a mirror. Pin builds in a fork.",
  git_failed: "Pin failed: git refused the ref.",
};

const hidden = (error: string): boolean => error === "unauthorized" || error === "not_found" || error === "forbidden";

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
    if (hidden(pinned.error)) return notFoundPage(ctx);
    return flashTo(ctx, `${base}/builds/new?sha=${encodeURIComponent(formValue(form, "sha"))}`, {
      tone: "danger",
      message: PIN_ERRORS[pinned.error] ?? "Pin failed.",
    });
  }
  return flashTo(ctx, `${base}/builds`, {
    message: `Pinned ${pinned.value.label} at ${pinned.value.oid.slice(0, 7)}.`,
  });
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
  return flashTo(
    ctx,
    `${repoBase(repo)}/builds`,
    gone.ok ? { message: `Deleted pin ${gone.value.label}.` } : { tone: "danger", message: "Delete failed." },
  );
}

const PREVIEW_ERRORS: Record<string, string> = {
  unverified: "Verify your email before previewing a build.",
  mirrored: "This repository is a mirror. Preview builds in a fork.",
  not_a_commit: "Commit not found in this repository.",
  no_runtime: "Apps are disabled on this forge.",
};

// POST /:owner/:name/builds/preview — serve one commit for a while, then open it.
export async function previewBuildSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const oid = formValue(form, "sha");
  const preview = await previewBuild(ctx.app, ctx.auth.user, repo, oid);
  if (!preview.ok) {
    if (hidden(preview.error)) return notFoundPage(ctx);
    return flashTo(ctx, `${repoBase(repo)}/builds`, {
      tone: "danger",
      message: PREVIEW_ERRORS[preview.error] ?? "Preview failed.",
    });
  }
  // Through the forge's own opener, so a private app's preview gets its grant.
  const opened = openEnvUrl(ctx.app, ctx.auth.user, repo, preview.value.env, "/");
  const url = opened.ok ? opened.value : preview.value.url;
  // Not a redirect: a form's redirect to another origin is held to the
  // page's CSP form-action. A script navigation is not; the proxy there
  // shows a page that refreshes itself until the build is up.
  return page({
    ctx,
    title: `Opening ${oid.slice(0, 7)} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    scriptJs: `location.replace(${JSON.stringify(url).replace(/</g, "\\u003c")});`,
    body: html`<div class="mt">
      ${card(
        html`<p>Starting build <span class="mono">${oid.slice(0, 7)}</span>.</p>
          <p><a class="btn" data-variant="primary" href="${url}">Open ${url}</a></p>`,
        { head: html`${icon("eye")}<h2>Opening preview</h2>` },
      )}
    </div>`,
  });
}
