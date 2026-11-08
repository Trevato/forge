/**
 * Settings › Labels: the labels that organise a repository's work, each one
 * renamed, recoloured or deleted in place, and a form to add another. Admin
 * only, every mutation a same-origin POST that says what happened. The frame
 * and the gate are settings.ts's; this module holds only what labels need.
 */

import { LABEL_WORDS } from "../../actions/label_words.ts";
import { createLabel, deleteLabel, updateLabel } from "../../actions/repos.ts";
import { listLabels, openLabelCounts, type Label } from "../../core/issues.ts";
import { notePhase, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, repoNotFound } from "../chrome.ts";
import { field, type Form } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo } from "../layout.ts";
import { btn, confirmAction, empty, labelChip, labelCss, row } from "../ui.ts";
import { adminForm, settingsPageResponse, timedAdminRepo } from "./settings.ts";

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
    /><span class="mono muted" data-hex>#${value}</span></span
  >`;
}

/** `N open`, a link to the issues list narrowed to the label; `unused` at 0. */
function usage(base: string, label: Label, open: number): Html {
  return open > 0
    ? html`<a class="label-open" href="${base}/issues?label=${encodeURIComponent(label.name)}">${open} open</a>`
    : html`<span class="muted">unused</span>`;
}

/** One label: its chip and open count at the head, the edit form in the trail. */
function labelRow(base: string, label: Label, open: number): Html {
  return row({
    id: `label-${label.id}`,
    title: labelChip(label),
    meta: usage(base, label, open),
    trail: html`<form
      class="row-fields edit-row"
      method="post"
      action="${base}/settings/labels/${label.id}"
    >
      <input
        class="input"
        type="text"
        name="name"
        value="${label.name}"
        aria-label="Name of the label ${label.name}"
        required
      />
      ${colorField(label.color, `Colour of the label ${label.name}`)}
      ${btn("Save", { size: "sm" })}
      ${confirmAction({
        action: `${base}/settings/labels/${label.id}/delete`,
        verb: "Delete",
        size: "sm",
        label: `Delete the label ${label.name}`,
      })}
    </form>`,
  });
}

export function labelsPage(ctx: Ctx): Response {
  const repo = timedAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const labels = timePhase(ctx.request, "labels", () => listLabels(ctx.app.db, repo.id));
  const counts = timePhase(ctx.request, "counts", () => openLabelCounts(ctx.app.db, repo.id));
  const rendering = performance.now();
  const base = repoBase(repo);

  const list =
    labels.length === 0
      ? empty({
          icon: "tag",
          title: "No labels yet",
          note: "Labels are this repository's work queue — a handful is usually enough.",
        })
      : html`<ul class="list setting-list">
          ${labels.map((l) => labelRow(base, l, counts.get(l.id) ?? 0))}
        </ul>`;

  const create = html`<section class="settings-block">
    <h2>New label</h2>
    <form
      class="row-fields edit-row mt"
      method="post"
      action="${base}/settings/labels"
    >
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
    </form>
  </section>`;

  const body = html`<section class="settings-block">${list}</section>
    ${create}`;
  const response = settingsPageResponse(
    ctx,
    repo,
    "labels",
    "Labels",
    body,
    labelCss(labels),
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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
              ? LABEL_WORDS.taken
              : LABEL_WORDS.shape,
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
              ? LABEL_WORDS.taken
              : updated.error === "not_found"
                ? LABEL_WORDS.gone
                : LABEL_WORDS.shape,
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
      : { tone: "danger", message: LABEL_WORDS.gone },
  );
}
