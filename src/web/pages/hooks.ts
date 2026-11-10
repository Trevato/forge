/**
 * Settings › Webhooks, admin-only: the hooks that carry this repository's
 * events out, the last deliveries of each, and the form that adds one. A
 * hook's signing secret is shown once, in the flash after it is created,
 * and never again. Pause quiets a failing hook where it is seen, as the
 * terminal's `p` does (`pauseWebhook`); a paused row reads `paused` in
 * place of its last delivery.
 */

import { createWebhook, deleteWebhook, pauseWebhook, redeliverWebhook } from "../../actions/repos.ts";
import { repoAdminNames } from "../../core/repo_admins.ts";
import { canWrite } from "../../core/repos.ts";
import { notePhase, timePhase } from "../../core/route_timing.ts";
import { getWebhook, listWebhooks, pingWebhook, recentDeliveries } from "../../core/webhooks.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, pageHead, repoBase, repoNotFound } from "../chrome.ts";
import { field } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import {
  btn,
  confirmAction,
  dot,
  field as formField,
  row,
  time,
} from "../ui.ts";
import { adminForm, settingsPageResponse, timedAdminRepo } from "./settings.ts";

/**
 * A writer who is not an admin follows the feed's failing-webhook line here:
 * they get a page naming who can act. Anyone else is refused as before.
 */
function notAdminPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo || !canWrite(ctx.app.db, repo, ctx.auth.user)) return repoNotFound(ctx);
  const names = repoAdminNames(ctx.app.db, repo);
  const who =
    names.length === 0
      ? html`a site admin of this forge`
      : html`${names.map((n, i) => html`${i > 0 ? ", " : ""}<a href="/${n}">${n}</a>`)}`;
  return page({
    ctx,
    title: `Webhooks · ${repo.name}`,
    crumbs: crumbsFor(repo),
    body: html`${pageHead("Webhooks", {
      sub: html`Only a repository admin can redeliver or pause a webhook; this repository's admins are ${who}.`,
    })}
    <p class="small"><a href="${repoBase(repo)}">Back to ${repo.name}</a></p>`,
  });
}

export function hooksPage(ctx: Ctx): Response {
  const repo = timedAdminRepo(ctx);
  if (!repo) return notAdminPage(ctx);
  const hooks = timePhase(ctx.request, "hooks", () => listWebhooks(ctx.app.db, repo.id));
  const recent = timePhase(
    ctx.request,
    "deliveries",
    () => new Map(hooks.map((h) => [h.id, recentDeliveries(ctx.app.db, h.id, 10)] as const)),
  );
  const rendering = performance.now();
  const base = repoBase(repo);

  const deliveryRow = (hookId: string, d: ReturnType<typeof recentDeliveries>[number]) =>
    row({
      title: html`<span class="mono">${d.kind}</span>`,
      meta: html`${dot(d.state === "ok" ? "success" : d.state === "failed" ? "danger" : "attn")}
        ${d.state} · ${d.attempts} ${d.attempts === 1 ? "attempt" : "attempts"} · ${d.lastError ?? d.lastStatus ?? "—"}`,
      trail: when(
        d.state === "failed",
        () => html`<form method="post" action="${base}/settings/hooks/${hookId}/deliveries/${d.id}/redeliver">
          ${btn("Redeliver", { size: "sm" })}
        </form>`,
      ),
    });

  const list =
    hooks.length === 0
      ? html`<p class="small">
          No webhooks yet. Every event this repository produces can be POSTed to a URL you control, signed and retried.
        </p>`
      : html`<ul class="list setting-list">
          ${hooks.map((hook) => {
            const deliveries = recent.get(hook.id) ?? [];
            return row({
              title: html`<span class="mono">${hook.url}</span>`,
              titleAttr: hook.url,
              meta: html`<span class="mono">${hook.kinds}</span> · ${dot(hook.active ? "success" : "attn")}${hook.active
                ? "active"
                : "paused"} · added ${time(hook.createdAt)}${when(!hook.hasSecret, () => html` · unsigned`)}${when(
                hook.active && deliveries.length === 0,
                () => html` · No deliveries yet.`,
              )}`,
              trail: html`<form method="post" action="${base}/settings/hooks/${hook.id}/${hook.active ? "pause" : "resume"}">
                  ${btn(hook.active ? "Pause" : "Resume", { size: "sm" })}
                </form>
                <form method="post" action="${base}/settings/hooks/${hook.id}/ping">
                  ${btn("Send ping", { size: "sm" })}
                </form>
                ${confirmAction({
                  action: `${base}/settings/hooks/${hook.id}/delete`,
                  verb: "Delete webhook",
                  size: "sm",
                })}`,
              children: deliveries.map((d) => deliveryRow(hook.id, d)),
            });
          })}
        </ul>`;

  const create = html`<form method="post" action="${base}/settings/hooks">
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
    <div class="form-actions">${btn("Add webhook", { variant: "primary" })}</div>
  </form>`;

  const body = html`<section class="settings-block">
      <h2>Webhooks</h2>
      ${list}
    </section>
    <section class="settings-block">
      <h2>Add a webhook</h2>
      ${create}
    </section>`;
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
  const done = redeliverWebhook(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "", ctx.params.delivery ?? "");
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/hooks`,
    done.ok
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

/**
 * POST …/settings/hooks/:id/pause and …/resume: one route each, so a
 * repeated post leaves the hook as it asked, never toggled back.
 */
function webhookSetPaused(paused: boolean) {
  return async (ctx: Ctx): Promise<Response> => {
    const gate = await adminForm(ctx);
    if (gate instanceof Response) return gate;
    const { repo } = gate;
    const done = pauseWebhook(ctx.app, ctx.auth.user, repo, ctx.params.id ?? "", paused);
    return flashTo(
      ctx,
      `${repoBase(repo)}/settings/hooks`,
      done.ok
        ? { message: paused ? "Webhook paused: it gets no deliveries until resumed." : "Webhook resumed." }
        : { tone: "danger", message: "That webhook no longer exists." },
    );
  };
}

export const webhookPause = webhookSetPaused(true);
export const webhookResume = webhookSetPaused(false);
