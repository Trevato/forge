/**
 * Repository settings, admin-only: what the repo is (description, visibility,
 * default branch, protection), the labels that organise its work, the
 * webhooks that carry its events out, and the one door marked danger.
 *
 * Four pages rather than one long scroll, because a settings page you have to
 * hunt through is a settings page people get wrong. Every mutation is its own
 * same-origin POST and every one of them says what happened.
 */

import {
  createLabel,
  createWebhook,
  deleteLabel,
  deleteRepo,
  deleteWebhook,
  updateLabel,
  updateRepoSettings,
} from "../../actions/repos.ts";
import { listLabels, type Label } from "../../core/issues.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { listWebhooks, recentDeliveries } from "../../core/webhooks.ts";
import { listRefs } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  crumbsFor,
  loadRepo,
  repoBase,
  repoHeader,
  repoNotFound,
  repoPalette,
  settingsLayout,
} from "../chrome.ts";
import { field, readForm, type Form } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo, page } from "../layout.ts";
import type { Flash } from "../flash.ts";
import {
  btn,
  card,
  confirmAction,
  dot,
  empty,
  field as formField,
  labelChip,
  labelCss,
  selectField,
  time,
} from "../ui.ts";

type Section = "general" | "labels" | "hooks" | "danger";

/** The repo, but only for someone who administers it. A non-admin is told
 * nothing — the settings tab is not even rendered for them. */
function loadAdminRepo(ctx: Ctx): Repo | undefined {
  const repo = loadRepo(ctx);
  if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return undefined;
  return repo;
}

function sections(base: string, active: Section) {
  return [
    {
      label: "General",
      href: `${base}/settings`,
      icon: "settings" as const,
      current: active === "general",
    },
    {
      label: "Labels",
      href: `${base}/settings/labels`,
      icon: "tag" as const,
      current: active === "labels",
    },
    {
      label: "Webhooks",
      href: `${base}/settings/hooks`,
      icon: "webhook" as const,
      current: active === "hooks",
    },
    {
      label: "Danger zone",
      href: `${base}/settings/danger`,
      icon: "alert" as const,
      current: active === "danger",
    },
  ];
}

/** Every settings page is the same frame with a different pane inside it. */
function settingsPageResponse(
  ctx: Ctx,
  repo: Repo,
  active: Section,
  title: string,
  body: Html,
  styleCss?: string,
): Response {
  return page({
    ctx,
    title: `${title} · ${repo.name}`,
    crumbs: crumbsFor(repo),
    palette: repoPalette(repo),
    ...(styleCss !== undefined ? { styleCss } : {}),
    body: html`${repoHeader(ctx, repo, "settings", { compact: true })}
    ${settingsLayout(sections(repoBase(repo), active), body)}`,
  });
}

/** The gate every settings POST passes: admin, same-origin, admin scope. */
async function adminForm(
  ctx: Ctx,
): Promise<{ repo: Repo; form: Form } | Response> {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  return { repo, form };
}

// ---- general ----

export async function settingsPage(ctx: Ctx): Promise<Response> {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const refs = await listRefs(dir, "refs/heads/");
  const branches = refs.ok
    ? refs.value.map((r) => r.name.replace("refs/heads/", "")).sort()
    : [];
  if (!branches.includes(repo.defaultBranch))
    branches.unshift(repo.defaultBranch);

  const body = card(
    html`<form method="post" action="${base}/settings">
      ${formField({
        label: "Description",
        name: "description",
        value: repo.description,
        hint: "One line, shown wherever this repository is listed.",
      })}
      ${selectField({
        label: "Visibility",
        name: "visibility",
        hint: "A private repository and a repository that does not exist look identical to anyone else.",
        options: [
          {
            value: "private",
            label: "Private",
            selected: repo.visibility === "private",
          },
          {
            value: "public",
            label: "Public",
            selected: repo.visibility === "public",
          },
        ],
      })}
      ${selectField({
        label: "Default branch",
        name: "defaultBranch",
        hint: "Where the repository opens, and what a bare clone checks out.",
        options: branches.map((b) => ({
          value: b,
          label: b,
          selected: b === repo.defaultBranch,
        })),
      })}
      <div class="field">
        <label class="check">
          <input
            type="checkbox"
            name="protect"
            ${repo.protectDefault ? html`checked` : null}
          />
          <span
            >Protect the default branch — no force-push, no deletion. Enforced
            by the pre-receive hook, so it holds for every client.</span
          >
        </label>
      </div>
      <div class="form-actions">
        ${btn("Save changes", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h2>General</h2>` },
  );
  return settingsPageResponse(ctx, repo, "general", "Settings", body);
}

export async function settingsUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const base = repoBase(repo);
  const branch = field(form, "defaultBranch");

  const updated = await updateRepoSettings(ctx.app, ctx.auth.user, repo, {
    description: field(form, "description"),
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    protectDefault: form.get("protect") !== null,
    ...(branch !== "" ? { defaultBranch: branch } : {}),
  });
  const flash: Flash = updated.ok
    ? { message: "Settings saved." }
    : {
        tone: "danger",
        message:
          updated.error === "unknown_branch"
            ? "That branch does not exist in this repository."
            : "Those settings could not be saved.",
      };
  return flashTo(ctx, `${base}/settings`, flash);
}

// ---- labels ----

/** `<input type="color">` submits `#rrggbb`; the store keeps six hex digits. */
function readColor(form: Form): string {
  return field(form, "color").replace(/^#/, "").toLowerCase();
}

/**
 * The colour control is a native `<input type="color">`, so it works with no
 * script at all — the hex beside it is a readout, updated live where there is
 * a script and correct on load where there is not. A browser submits it as
 * `#rrggbb`; `readColor` strips the hash on the way in.
 */
function colorField(value: string, label: string): Html {
  return html`<span class="color-field"
    ><input
      type="color"
      name="color"
      value="#${value}"
      aria-label="${label}"
    /><span class="hex">#${value}</span></span
  >`;
}

function labelEditor(base: string, label: Label): Html {
  return html`<li>
    <form
      class="edit-row"
      method="post"
      action="${base}/settings/labels/${label.id}"
    >
      <span class="preview">${labelChip(label)}</span>
      <input
        class="input"
        type="text"
        name="name"
        value="${label.name}"
        aria-label="Label name"
        required
      />
      ${colorField(label.color, `Colour of the label ${label.name}`)}
      ${btn("Save", { size: "sm" })}
      ${confirmAction({
        action: `${base}/settings/labels/${label.id}/delete`,
        verb: "Delete",
        size: "sm",
      })}
    </form>
  </li>`;
}

export function labelsPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const labels = listLabels(ctx.app.db, repo.id);

  const list =
    labels.length === 0
      ? empty({
          icon: "tag",
          title: "No labels yet",
          note: "Labels are this repository's work queue — a handful is usually enough.",
        })
      : html`<div class="card">
          <ul class="list">
            ${labels.map((l) => labelEditor(base, l))}
          </ul>
        </div>`;

  const create = card(
    html`<form class="edit-row" method="post" action="${base}/settings/labels">
      <input
        class="input"
        type="text"
        name="name"
        placeholder="Label name"
        aria-label="New label name"
        required
      />
      ${colorField("6b7280", "Colour of the new label")}
      ${btn("Add label", { variant: "primary", size: "sm" })}
    </form>`,
    { head: html`<h2>New label</h2>`, pad: false },
  );

  const body = html`${list}
    <div class="mt">${create}</div>`;
  return settingsPageResponse(
    ctx,
    repo,
    "labels",
    "Labels",
    body,
    labelCss(labels),
  );
}

export async function labelCreate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const created = createLabel(
    ctx.app,
    ctx.auth.user,
    repo,
    field(form, "name"),
    readColor(form) || "6b7280",
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/labels`,
    created.ok
      ? { message: `Label “${created.value.name}” created.` }
      : {
          tone: "danger",
          message:
            created.error === "taken"
              ? "This repository already has a label by that name."
              : "A label needs a name and a six-digit hex color.",
        },
  );
}

export async function labelUpdate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const updated = updateLabel(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
    field(form, "name"),
    readColor(form),
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/labels`,
    updated.ok
      ? { message: `Label “${updated.value.name}” updated.` }
      : {
          tone: "danger",
          message:
            updated.error === "taken"
              ? "This repository already has a label by that name."
              : updated.error === "not_found"
                ? "That label no longer exists."
                : "A label needs a name and a six-digit hex color.",
        },
  );
}

export async function labelDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const removed = deleteLabel(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/labels`,
    removed.ok
      ? { message: "Label deleted." }
      : { tone: "danger", message: "That label no longer exists." },
  );
}

// ---- webhooks ----

export function hooksPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const hooks = listWebhooks(ctx.app.db, repo.id);

  const list =
    hooks.length === 0
      ? empty({
          icon: "webhook",
          title: "No webhooks yet",
          note: "Every event this repository produces can be POSTed to a URL you control, signed and retried.",
        })
      : html`${hooks.map((hook) => {
          const deliveries = recentDeliveries(ctx.app.db, hook.id, 10);
          return card(
            deliveries.length === 0
              ? html`<p class="muted small">No deliveries yet.</p>`
              : html`<div class="table-scroll">
                  <table class="table" data-dense>
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>State</th>
                        <th>Attempts</th>
                        <th>Last status</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${deliveries.map(
                        (d) =>
                          html`<tr>
                            <td class="mono">${d.kind}</td>
                            <td>
                              ${dot(
                                d.state === "ok"
                                  ? "success"
                                  : d.state === "failed"
                                    ? "danger"
                                    : "attn",
                              )}
                              ${d.state}
                            </td>
                            <td>${d.attempts}</td>
                            <td>${d.lastStatus ?? "—"}</td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`,
            {
              pad: deliveries.length === 0,
              head: html`<span class="grow truncate mono" title="${hook.url}"
                  >${hook.url}</span
                >
                <span class="badge" data-variant="secondary"
                  >${hook.kinds}</span
                >
                <span class="badge"
                  >${dot(hook.active ? "success" : "attn")}${hook.active
                    ? "active"
                    : "paused"}</span
                >
                ${confirmAction({
                  action: `${base}/settings/hooks/${hook.id}/delete`,
                  verb: "Delete webhook",
                  size: "sm",
                })}`,
              foot: html`<span class="muted small"
                >Added
                ${time(hook.createdAt)}${when(
                  !hook.hasSecret,
                  () => html` · unsigned`,
                )}</span
              >`,
            },
          );
        })}`;

  const create = card(
    html`<form method="post" action="${base}/settings/hooks">
      ${formField({
        label: "Payload URL",
        name: "url",
        type: "url",
        required: true,
        placeholder: "https://example.com/hook",
        hint: "Every delivery is a POST with a JSON body.",
      })}
      ${formField({
        label: "Events",
        name: "kinds",
        value: "*",
        mono: true,
        hint: "A space-separated list of kinds; * means everything. e.g. push issue.* pull.merged",
      })}
      ${formField({
        label: "Signing secret",
        name: "secret",
        mono: true,
        hint: "Optional — one is generated for you. Deliveries carry HMAC-SHA256 in X-Forge-Signature-256.",
      })}
      <div class="form-actions">
        ${btn("Add webhook", { variant: "primary" })}
      </div>
    </form>`,
    { head: html`<h2>New webhook</h2>` },
  );

  const body = html`${list}
    <div class="mt">${create}</div>`;
  return settingsPageResponse(ctx, repo, "hooks", "Webhooks", body);
}

export async function webhookCreate(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const providedSecret = field(form, "secret");
  const created = createWebhook(ctx.app, ctx.auth.user, repo, {
    url: field(form, "url"),
    kinds: field(form, "kinds") || "*",
    ...(providedSecret !== "" ? { secret: providedSecret } : {}),
  });
  if (!created.ok) {
    return flashTo(ctx, `${repoBase(repo)}/settings/hooks`, {
      tone: "danger",
      message: "That URL is not one this forge will deliver to.",
    });
  }
  // The only moment the secret exists outside the database: show it once.
  return flashTo(ctx, `${repoBase(repo)}/settings/hooks`, {
    message:
      "Webhook created. Copy its signing secret now — it is never shown again.",
    code: created.value.secret,
  });
}

export async function webhookDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const removed = deleteWebhook(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/hooks`,
    removed.ok
      ? { message: "Webhook deleted." }
      : { tone: "danger", message: "That webhook no longer exists." },
  );
}

// ---- danger zone ----

export function dangerPage(ctx: Ctx): Response {
  const repo = loadAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const base = repoBase(repo);
  const full = `${repo.ownerName}/${repo.name}`;

  const body = card(
    html`<p>
        Deleting <strong>${full}</strong> removes its issues, pull requests,
        reviews, labels and webhooks, and erases the git objects from disk.
      </p>
      <p class="muted small mt">
        Any fork of this repository is detached first — it repacks so it owns
        its objects, then loses the link. Forks survive; this repository does
        not. There is no undo and no backup.
      </p>
      <div class="form-actions">
        ${confirmAction({
          action: `${base}/settings/delete`,
          verb: "Delete this repository",
        })}
      </div>`,
    {
      tone: "danger",
      head: html`${icon("alert")}
        <h2>Delete this repository</h2>`,
    },
  );
  return settingsPageResponse(ctx, repo, "danger", "Danger zone", body);
}

/**
 * The typed-name check lives here and nowhere else: the confirm page collects
 * the phrase, this handler is the one that refuses without it.
 */
export async function repoDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const full = `${repo.ownerName}/${repo.name}`;
  if (field(form, "confirm") !== full) {
    return flashTo(ctx, `${repoBase(repo)}/settings/danger`, {
      tone: "danger",
      message: `Type ${full} exactly to confirm. Nothing was deleted.`,
    });
  }
  const deleted = await deleteRepo(ctx.app, ctx.auth.user, repo);
  if (!deleted.ok) {
    return flashTo(ctx, `${repoBase(repo)}/settings/danger`, {
      tone: "danger",
      message: "The repository could not be deleted.",
    });
  }
  return flashTo(ctx, "/", { message: `${full} was deleted.` });
}
