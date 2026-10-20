/**
 * "Make it yours" (#606), as a page: GET shows what will be copied and what
 * will not, and the name it will have; POST makes it and lands the person on
 * their new app, whose first deploy is already under way. Decided in
 * `actions/make_it_yours.ts`.
 */

import { COPIES_PER_DAY, makeItYours } from "../../actions/make_it_yours.ts";
import type { Ctx } from "../../http/context.ts";
import {
  loadRepo,
  notFoundPage,
  pageHead,
  repoBase,
  signInFirst,
} from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, when } from "../html.ts";
import { flashTo, page, redirect } from "../layout.ts";
import { btn, card } from "../ui.ts";
import { NOT_A_MEMBER } from "../../core/roles.ts";
import {
  notePhase,
  takeSessionTime,
  timePhaseAsync,
  timePhase,
} from "../../core/route_timing.ts";

// GET /:owner/:name/make-it-yours
export async function makeItYoursPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const user = ctx.auth.user;
  const plan = await timePhaseAsync(ctx.request, "plan", () =>
    makeItYours(ctx.app, user, repo, { dryRun: true }),
  );
  if (!plan.ok) {
    if (plan.error.kind === "own")
      return flashTo(ctx, repoBase(repo), {
        tone: "attn",
        message: "This app is already yours.",
      });
    if (plan.error.kind === "not_found") return notFoundPage(ctx);
    return flashTo(ctx, repoBase(repo), {
      tone: "danger",
      message:
        plan.error.kind === "invalid"
          ? plan.error.message
          : plan.error.kind === "not_member"
            ? `Not for this account: ${NOT_A_MEMBER}.`
            : "That could not be made yours.",
    });
  }
  const p = plan.value;
  const rendering = performance.now();
  const body = html`<div class="narrow-wide">
    ${pageHead("Make it yours", {
      sub: p.existing
        ? html`You already have <strong>${p.repo}</strong>, a copy of ${p.from}.
            Open it, as an app of yours.`
        : html`A copy of <strong>${p.from}</strong> in your account, running as
            your own app, that keeps up with the original until you change it.`,
    })}
    ${card(
      html`<form
        method="post"
        action="${repoBase(repo)}/make-it-yours"
        class="stack"
      >
        <dl class="kv">
          <dt>Yours as</dt>
          <dd class="mono">${p.repo}</dd>
          <dt>Its address</dt>
          <dd class="mono">${p.slug}</dd>
          <dt>Copied</dt>
          <dd>${p.copied.join(", ")}</dd>
          <dt>Not copied</dt>
          <dd>
            ${p.notCopied.join(", ")} — they stay ${p.from.split("/")[0]}'s;
            yours starts empty.
          </dd>
          <dt>Follows</dt>
          <dd>
            ${p.from}: it moves with the original until you change it, and tells
            you when it cannot.
          </dd>
          ${p.existing
            ? html`<dt>Who sees it</dt>
                <dd>${p.visibility === "public" ? "anyone" : "you"}</dd>`
            : html`<dt>Who sees it</dt>
                <dd class="stack stack-tight">
                  <label
                    ><input type="radio" name="visibility" value="private" checked />
                    Only you, until you open it up</label
                  >
                  ${when(
                    repo.visibility === "public",
                    () =>
                      html`<label
                        ><input type="radio" name="visibility" value="public" />
                        Anyone, from the start</label
                      >`,
                  )}
                </dd>
                <dt>Today</dt>
                <dd>
                  ${p.copiesLeft} more cop${p.copiesLeft === 1 ? "y" : "ies"} you
                  can make in the next day
                </dd>`}
        </dl>
        <div class="form-actions">
          ${btn(p.existing ? "Open mine" : "Make it yours", {
            variant: "primary",
            icon: "fork",
          })}
          ${btn("Not now", { href: repoBase(repo), variant: "ghost" })}
        </div>
      </form>`,
    )}
  </div>`;
  const response = page({ ctx, title: `Make ${p.from} yours`, body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

// POST /:owner/:name/make-it-yours
export async function makeItYoursSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const name = field(form, "name").trim();
  const made = await makeItYours(ctx.app, ctx.auth.user, repo, {
    dryRun: false,
    visibility: field(form, "visibility") === "public" ? "public" : "private",
    ...(name === "" ? {} : { name }),
  });
  if (!made.ok || made.value.made === undefined) {
    const message = !made.ok
      ? made.error.kind === "invalid"
        ? made.error.message
        : made.error.kind === "repository_limit" || made.error.kind === "storage_limit"
          ? `Not made: ${made.error.message}.`
        : made.error.kind === "not_member"
          ? `Not made: ${NOT_A_MEMBER}.`
        : made.error.kind === "own"
          ? "This app is already yours."
          : made.error.kind === "unverified"
            ? "Prove your email first: the link is in your inbox."
            : made.error.kind === "limit"
              ? `That is today's copies made (${COPIES_PER_DAY} a day). Another can be made after ${made.error.resetsAt.slice(11, 16)} UTC.`
              : "That could not be made yours."
      : "That could not be made yours.";
    return flashTo(ctx, repoBase(repo), { tone: "danger", message });
  }
  return redirect(repoBase(made.value.made.repo), {
    url: ctx.url,
    flash: {
      message: made.value.existing
        ? `This is your ${made.value.repo}.`
        : `${made.value.repo} is yours. Its first deploy is under way.`,
    },
  });
}
