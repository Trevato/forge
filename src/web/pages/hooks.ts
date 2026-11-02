/**
 * Settings › Webhooks, admin-only: the hooks that carry this repository's
 * events out, the last deliveries of each, and the form that adds one. A
 * hook's signing secret is shown once, in the flash after it is created,
 * and never again.
 */

import { createWebhook, deleteWebhook } from "../../actions/repos.ts";
import { notePhase, timePhase } from "../../core/route_timing.ts";
import { getWebhook, listWebhooks, pingWebhook, recentDeliveries, redeliver } from "../../core/webhooks.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, repoNotFound } from "../chrome.ts";
import { field } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo } from "../layout.ts";
import {
  btn,
  card,
  confirmAction,
  dot,
  empty,
  field as formField,
  time,
} from "../ui.ts";
import { adminForm, settingsPageResponse, timedAdminRepo } from "./settings.ts";

export function hooksPage(ctx: Ctx): Response {
  const repo = timedAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const hooks = timePhase(ctx.request, "hooks", () => listWebhooks(ctx.app.db, repo.id));
  const recent = timePhase(
    ctx.request,
    "deliveries",
    () => new Map(hooks.map((h) => [h.id, recentDeliveries(ctx.app.db, h.id, 10)] as const)),
  );
  const rendering = performance.now();
  const base = repoBase(repo);

  const list =
    hooks.length === 0
      ? empty({
          icon: "webhook",
          title: "No webhooks yet",
          note: "Every event this repository produces can be POSTed to a URL you control, signed and retried.",
        })
      : html`${hooks.map((hook) => {
          const deliveries = recent.get(hook.id) ?? [];
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
                        <th><span class="sr-only">Actions</span></th>
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
                            <td>${d.lastError ?? d.lastStatus ?? "—"}</td>
                            <td>
                              ${when(
                                d.state === "failed",
                                () =>
                                  html`<form
                                    method="post"
                                    action="${base}/settings/hooks/${hook.id}/deliveries/${d.id}/redeliver"
                                  >
                                    ${btn("Redeliver", { size: "sm" })}
                                  </form>`,
                              )}
                            </td>
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
                <form method="post" action="${base}/settings/hooks/${hook.id}/ping">
                  ${btn("Send ping", { size: "sm" })}
                </form>
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
  const response = settingsPageResponse(ctx, repo, "hooks", "Webhooks", body);
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
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

export async function webhookRedeliver(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const hook = getWebhook(ctx.app.db, repo.id, ctx.params.id ?? "");
  const done = hook
    ? redeliver(ctx.app.db, ctx.params.delivery ?? "", hook.id)
    : undefined;
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/hooks`,
    done?.ok
      ? { message: "Delivery queued again." }
      : { tone: "danger", message: "That delivery cannot be sent again." },
  );
}

export async function webhookPing(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const to = `${repoBase(repo)}/settings/hooks`;
  const hook = getWebhook(ctx.app.db, repo.id, ctx.params.id ?? "");
  if (!hook) return flashTo(ctx, to, { tone: "danger", message: "That webhook no longer exists." });
  const pinged = pingWebhook(ctx.app.db, `${repo.ownerName}/${repo.name}`, hook);
  return flashTo(
    ctx,
    to,
    pinged.ok
      ? { message: "Ping queued: it shows among this webhook's deliveries." }
      : { tone: "danger", message: `Too many pings: try again in ${pinged.error.retryAfter} s.` },
  );
}
