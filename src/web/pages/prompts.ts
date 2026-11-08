/**
 * Settings › Prompts, admin-only: the Instagram account whose top comment on
 * the latest Reel becomes the crew's next tell, and the three forms that
 * connect it, fetch it now and remove it. The frame, the tab bar and the
 * admin gate are the settings page's, imported from it.
 */

import {
  addPromptSource,
  listPromptSources,
  removePromptSource,
  runPromptSource,
  type PromptSourceView,
} from "../../actions/prompts.ts";
import { REFRESH_AFTER_DAYS } from "../../crew/prompts.ts";
import { timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase, repoNotFound } from "../chrome.ts";
import { field } from "../form.ts";
import { html, type Html } from "../html.ts";
import { icon } from "../icons.ts";
import { flashTo } from "../layout.ts";
import {
  badge,
  btn,
  confirmAction,
  field as formField,
  row,
  time,
  timeAgo,
} from "../ui.ts";
import { adminForm, settingsPageResponse, timedAdminRepo } from "./settings.ts";

const PROMPT_ERRORS: Record<string, string> = {
  invalid_at: "The time is hours and minutes in UTC, like 15:00.",
  invalid_token:
    "Paste the long-lived token as Instagram gave it: one line, no spaces.",
  invalid_kind: "Only Instagram is known here.",
  already_connected:
    "An Instagram account is already connected here. Remove it first.",
  no_such_source: "No account by that id.",
  not_running: "The prompt routine is not running on this forge.",
};

/** The day the forge will refresh a token pasted or refreshed at `iso`. */
function refreshDay(iso: string): string {
  return new Date(Date.parse(iso) + REFRESH_AFTER_DAYS * 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The Instagram section: the account and what the last run said when one is
 * connected, the form when none is. Beneath it, the one-time steps at Meta,
 * because the forge cannot take them for anyone. The token is a password
 * field on the way in and nowhere on the way out.
 */
function promptsView(base: string, sources: PromptSourceView[]): Html {
  const source = sources.find((s) => s.kind === "instagram");
  const at = (id: string) =>
    `${base}/settings/prompts/${encodeURIComponent(id)}`;
  const list =
    source === undefined
      ? html`<p class="muted small">
          Once a day, the top comment on your latest Reel becomes the crew's
          next tell. No account is connected yet.
        </p>`
      : html`<ul class="list setting-list">
          ${row({
            id: `prompt-${source.id}`,
            lead: icon("comment"),
            title: html`${source.account === ""
                ? html`<span class="muted">not read yet</span>`
                : `@${source.account}`}
              ${badge(`every day at ${source.atUtc} UTC`)}`,
            meta: html`${source.lastRanAt === null
                ? "Has not run yet."
                : html`Last ran ${time(source.lastRanAt)}. ${source.lastSaid}`}
              Token refreshed ${timeAgo(source.tokenRefreshedAt)}; the forge
              refreshes it again around ${refreshDay(source.tokenRefreshedAt)}.`,
            trail: html`<form method="post" action="${at(source.id)}/run">
                ${btn("Fetch now", { size: "sm", icon: "sync" })}
              </form>
              ${confirmAction({
                action: `${at(source.id)}/delete`,
                verb: "Remove",
                size: "sm",
              })}`,
          })}
        </ul>`;
  const add =
    source !== undefined
      ? null
      : html`<form
          class="mt"
          method="post"
          action="${base}/settings/prompts"
        >
          ${formField({
            label: "Token",
            name: "token",
            type: "password",
            hint: "A long-lived Instagram token. The forge seals it, refreshes it before it expires, and never shows it again.",
            required: true,
            autocomplete: "off",
            mono: true,
          })}
          ${formField({
            label: "Every day at … UTC",
            name: "at",
            type: "time",
            value: "15:00",
            required: true,
          })}
          <div class="form-actions">
            ${btn("Add", { variant: "primary", icon: "plus" })}
          </div>
        </form>`;
  return html`<section class="settings-block">
      <h2>Instagram</h2>
      ${list}${add}
    </section>
    <section class="settings-block">
      <h2>Getting a token</h2>
      <p class="muted small">
        The one-time steps at Meta, for a professional account of your own. None
        of them needs App Review.
      </p>
      <ol class="muted">
        <li>
          Make the Instagram account a professional one — Business or Creator —
          in the Instagram app's settings.
        </li>
        <li>
          At developers.facebook.com, make a Meta app and add the Instagram
          product with <b>Business Login for Instagram</b>. No Facebook Page is
          needed.
        </li>
        <li>
          Get a token for the account with the scopes
          <span class="mono">instagram_business_basic</span> and
          <span class="mono">instagram_business_manage_comments</span>.
        </li>
        <li>
          Exchange it for a long-lived token, the one that lives sixty days; the
          product's docs show the one call.
        </li>
        <li>
          Paste the long-lived token above. The forge refreshes it before it
          expires, and the paste is never shown again.
        </li>
      </ol>
    </section>`;
}

// GET /:owner/:name/settings/prompts
export function promptsSettingsPage(ctx: Ctx): Response {
  const repo = timedAdminRepo(ctx);
  if (!repo) return repoNotFound(ctx);
  const listed = timePhase(ctx.request, "sources", () => listPromptSources(ctx.app, ctx.auth.user, repo));
  return timePhase(ctx.request, "render", () =>
    settingsPageResponse(
      ctx,
      repo,
      "prompts",
      "Prompts",
      promptsView(repoBase(repo), listed.ok ? listed.value : []),
    ),
  );
}

// POST /:owner/:name/settings/prompts — connect an account.
export async function promptSourceAdd(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo, form } = gate;
  const added = addPromptSource(ctx.app, ctx.auth.user, repo, {
    kind: "instagram",
    token: field(form, "token"),
    at: field(form, "at"),
  });
  if (!added.ok && added.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/prompts`,
    added.ok
      ? {
          message: `Instagram is connected. Every day at ${added.value.atUtc} UTC the top comment on the latest Reel is told to the crew; press Fetch now to try it.`,
        }
      : {
          tone: "danger",
          message:
            PROMPT_ERRORS[added.error] ?? "The account could not be connected.",
        },
  );
}

// POST /:owner/:name/settings/prompts/:id/run — look at Instagram now.
export async function promptSourceRun(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const ran = await runPromptSource(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  if (!ran.ok && ran.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/prompts`,
    ran.ok
      ? {
          ...(ran.value.lastSaid.startsWith("Told the crew")
            ? {}
            : { tone: "attn" as const }),
          message: ran.value.lastSaid,
        }
      : {
          tone: "danger",
          message: PROMPT_ERRORS[ran.error] ?? "No account by that id.",
        },
  );
}

// POST /:owner/:name/settings/prompts/:id/delete
export async function promptSourceDelete(ctx: Ctx): Promise<Response> {
  const gate = await adminForm(ctx);
  if (gate instanceof Response) return gate;
  const { repo } = gate;
  const removed = removePromptSource(
    ctx.app,
    ctx.auth.user,
    repo,
    ctx.params.id ?? "",
  );
  if (!removed.ok && removed.error === "not_found") return repoNotFound(ctx);
  return flashTo(
    ctx,
    `${repoBase(repo)}/settings/prompts`,
    removed.ok
      ? { message: "Instagram is disconnected. The token is forgotten." }
      : { tone: "danger", message: "No account by that id." },
  );
}
