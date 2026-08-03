/**
 * Repository settings, owner-only: description and visibility, protection of
 * the default branch (enforced by the pre-receive hook), and labels. Plain
 * forms; each action is its own same-origin POST.
 */

import { createLabel, deleteLabel, listLabels } from "../../core/issues.ts";
import { canWrite, updateRepoSettings } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { field, readForm } from "../form.ts";
import { html, raw } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { crumbsFor, loadRepo, repoNav, repoNotFound } from "./repo.ts";

// GET /:owner/:name/settings
export function settingsPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!canWrite(repo, ctx.auth.user)) return repoNotFound(ctx);
  const base = `/${repo.ownerName}/${repo.name}`;
  const labels = listLabels(ctx.app.db, repo.id);

  const body = html`${repoNav(repo, "settings")}
    <div class="narrow-wide">
      <h2>Settings</h2>

      <form class="card settings-card" method="post" action="${base}/settings">
        <label for="description">Description</label>
        <input
          class="input"
          id="description"
          name="description"
          value="${repo.description}"
        />
        <label for="visibility">Visibility</label>
        <select class="input" id="visibility" name="visibility">
          <option
            value="private"
            ${repo.visibility === "private" ? raw("selected") : null}
          >
            Private
          </option>
          <option
            value="public"
            ${repo.visibility === "public" ? raw("selected") : null}
          >
            Public
          </option>
        </select>
        <label class="check">
          <input
            type="checkbox"
            name="protect"
            ${repo.protectDefault ? raw("checked") : null}
          />
          Protect the default branch (<span class="mono"
            >${repo.defaultBranch}</span
          >) — no force-push, no deletion
        </label>
        <div class="form-actions">
          <button class="btn" data-variant="primary" type="submit">Save</button>
        </div>
      </form>

      <div class="card settings-card">
        <h3>Labels</h3>
        ${labels.length === 0
          ? html`<p class="muted small">No labels yet.</p>`
          : html`<ul class="label-list">
              ${labels.map(
                (l) =>
                  html`<li>
                    <span class="label-chip lc-${l.color}">${l.name}</span>
                    <form
                      method="post"
                      action="${base}/settings/labels/${l.id}/delete"
                      class="inline"
                    >
                      <button
                        class="btn"
                        data-size="sm"
                        data-variant="danger"
                        type="submit"
                      >
                        Delete
                      </button>
                    </form>
                  </li>`,
              )}
            </ul>`}
        <form method="post" action="${base}/settings/labels" class="label-new">
          <input class="input" name="name" placeholder="Label name" required />
          <input
            class="input color"
            name="color"
            placeholder="6b7280"
            pattern="[0-9a-fA-F]{6}"
            value="6b7280"
          />
          <button class="btn" type="submit">Add label</button>
        </form>
      </div>
    </div>`;
  return page({
    title: `Settings · ${repo.name}`,
    user: ctx.auth.user,
    crumbs: crumbsFor(repo),
    body,
    styleCss: labelCssFor(labels),
  });
}

function labelCssFor(labels: { color: string }[]): string {
  let css = "";
  const seen = new Set<string>();
  for (const { color } of labels) {
    if (seen.has(color) || !/^[0-9a-f]{6}$/.test(color)) continue;
    seen.add(color);
    css += `.lc-${color}{--label:#${color}}`;
  }
  return css;
}

// POST /:owner/:name/settings
export async function settingsUpdate(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!canWrite(repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;

  updateRepoSettings(ctx.app.db, repo, {
    description: field(form, "description"),
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    protectDefault: form.get("protect") !== null,
  });
  return redirect(`/${repo.ownerName}/${repo.name}/settings`);
}

// POST /:owner/:name/settings/labels
export async function labelCreate(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!canWrite(repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  createLabel(
    ctx.app.db,
    repo.id,
    field(form, "name"),
    field(form, "color") || "6b7280",
  );
  return redirect(`/${repo.ownerName}/${repo.name}/settings`);
}

// POST /:owner/:name/settings/labels/:id/delete
export async function labelDelete(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  if (!canWrite(repo, ctx.auth.user)) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  deleteLabel(ctx.app.db, repo.id, ctx.params.id ?? "");
  return redirect(`/${repo.ownerName}/${repo.name}/settings`);
}
