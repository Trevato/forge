/**
 * "Make it yours" (#606), as a page: GET shows what will be copied and what
 * will not, and the name it will have; POST makes it and lands the person on
 * their new app, whose first deploy is already under way. Decided in
 * `actions/make_it_yours.ts`.
 */

import { COPIES_PER_DAY, makeItYours, receiptWords, undoMakeItYours } from "../../actions/make_it_yours.ts";
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
import { btn, card, row } from "../ui.ts";
import { HELP_BUILD, HELP_BUILD_NEXT, SIGNUP_OWN_FORGE } from "../../core/contribute.ts";
import type { Repo } from "../../core/repos.ts";
import { NOT_A_MEMBER } from "../../core/roles.ts";
import {
  notePhase,
  takeSessionTime,
  timePhaseAsync,
  timePhase,
} from "../../core/route_timing.ts";

type Refusal = Extract<Awaited<ReturnType<typeof makeItYours>>, { ok: false }>["error"];

/** Where a refused plan lands: back on the repository, saying why. */
function planRefused(ctx: Ctx, repo: NonNullable<ReturnType<typeof loadRepo>>, error: Refusal): Response {
  if (error.kind === "own")
    return flashTo(ctx, repoBase(repo), {
      tone: "attn",
      message: "This app is already yours.",
    });
  if (error.kind === "not_found") return notFoundPage(ctx);
  return flashTo(ctx, repoBase(repo), {
    tone: "danger",
    message:
      error.kind === "invalid"
        ? error.message
        : error.kind === "not_member"
          ? `Not for this account: ${NOT_A_MEMBER}.`
          : "That could not be made yours.",
  });
}

/** What a guest sees in place of a copy: help this one, and what happens next. */
function helpBuildPage(ctx: Ctx, repo: Repo): Response {
  return page({
    ctx,
    title: `${HELP_BUILD} · ${repo.ownerName}/${repo.name}`,
    body: html`<div class="narrow-wide">
      ${pageHead(HELP_BUILD, { sub: `${repo.ownerName}/${repo.name}` })}
      ${card(html`<p>${HELP_BUILD_NEXT}</p>
        <p class="muted small mt">${SIGNUP_OWN_FORGE} <a href="/forges/new">Get your own forge</a>.</p>
        <form method="post" action="${repoBase(repo)}/fork" class="form-actions">
          ${btn(HELP_BUILD, { variant: "primary", icon: "fork" })}
          ${btn("Not now", { href: repoBase(repo), variant: "ghost" })}
        </form>`)}
    </div>`,
  });
}

// GET /:owner/:name/make-it-yours
export async function makeItYoursPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = timePhase(ctx.request, "repo", () => loadRepo(ctx));
  if (!repo) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  if (!ctx.auth.user) return timePhase(ctx.request, "render", () => signInFirst(ctx));
  const user = ctx.auth.user;
  const plan = await timePhaseAsync(ctx.request, "plan", () =>
    makeItYours(ctx.app, user, repo, { dryRun: true }),
  );
  if (!plan.ok && plan.error.kind === "not_member" && repo.visibility === "public")
    return timePhase(ctx.request, "render", () => helpBuildPage(ctx, repo));
  if (!plan.ok)
    return timePhase(ctx.request, "render", () => planRefused(ctx, repo, plan.error));
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
        ${when(
          ctx.url.searchParams.get("receipt") === "1",
          () => html`<input type="hidden" name="receipt" value="1" />`,
        )}
        <ul class="list setting-list">
          ${row({ title: "Yours as", trail: html`<span class="mono">${p.repo}</span>` })}
          ${row({ title: "Its address", trail: html`<span class="mono">${p.slug}</span>` })}
          ${row({ title: "Copied", meta: html`${p.copied.join(", ")}` })}
          ${row({
            title: "Not copied",
            meta: html`${p.notCopied.join(", ")} — they stay
            ${p.from.split("/")[0]}'s; yours starts empty.`,
          })}
          ${row({
            title: "Follows",
            meta: html`${p.from}: it moves with the original until you change
            it, and tells you when it cannot.`,
          })}
          ${p.existing
            ? row({
                title: "Who sees it",
                trail: html`${p.visibility === "public" ? "anyone" : "you"}`,
              })
            : html`${row({
                title: "Who sees it",
                trail: html`<span class="row-fields" role="radiogroup" aria-label="Who sees it"
                  ><label class="check"
                    ><input type="radio" name="visibility" value="private" checked />
                    Only you, until you open it up</label
                  >
                  ${when(
                    repo.visibility === "public",
                    () =>
                      html`<label class="check"
                        ><input type="radio" name="visibility" value="public" />
                        Anyone, from the start</label
                      >`,
                  )}</span
                >`,
              })}
              ${row({
                title: "Today",
                meta: html`${p.copiesLeft} more cop${p.copiesLeft === 1 ? "y" : "ies"}
                you can make in the next day`,
              })}`}
        </ul>
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
              ? `That is today's copies made (${COPIES_PER_DAY} a day). ` +
                `Another can be made after ${made.error.resetsAt.slice(11, 16)} UTC.`
              : "That could not be made yours."
      : "That could not be made yours.";
    return flashTo(ctx, repoBase(repo), { tone: "danger", message });
  }
  if (field(form, "receipt") === "1")
    return redirect(`${repoBase(repo)}/make-it-yours/receipt${made.value.existing ? "" : "?made=1"}`, {
      url: ctx.url,
      forgeUrl: ctx.app.config.url,
    });
  return redirect(repoBase(made.value.made.repo), {
    url: ctx.url,
    forgeUrl: ctx.app.config.url,
    flash: {
      message: made.value.existing
        ? `This is your ${made.value.repo}.`
        : `${made.value.repo} is yours. Its first deploy is under way.`,
    },
  });
}

// GET /:owner/:name/make-it-yours/receipt — what one tap did, in words, with Undo.
export async function makeItYoursReceipt(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const plan = await makeItYours(ctx.app, ctx.auth.user, repo, { dryRun: true });
  if (!plan.ok || !plan.value.existing)
    return flashTo(ctx, "/explore", { tone: "attn", message: "Nothing of yours was made from that app." });
  const p = plan.value;
  // Undo is offered for the copy this tap just made, not one made earlier.
  const justMade = ctx.url.searchParams.get("made") === "1";
  return page({
    ctx,
    title: p.existing && !justMade ? `${p.repo} was already yours` : `${p.repo} is yours`,
    body: html`<div class="narrow-wide">
      ${pageHead(justMade ? receiptWords({ ...p, existing: false }) : receiptWords(p))}
      <div class="form-actions">
        ${btn("Open mine", { href: `/${p.repo}`, variant: "primary", icon: "fork" })}
        ${when(
          justMade,
          () =>
            html`<form method="post" action="${repoBase(repo)}/make-it-yours/undo">${btn("Undo", {
              variant: "ghost",
            })}</form>`,
        )}
        ${btn("Back to explore", { href: "/explore", variant: "ghost" })}
      </div>
    </div>`,
  });
}

// POST /:owner/:name/make-it-yours/undo
export async function makeItYoursUndo(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const undone = await undoMakeItYours(ctx.app, ctx.auth.user, repo);
  if (!undone.ok)
    return flashTo(ctx, "/explore", {
      tone: "danger",
      message: undone.error.kind === "changed" ? undone.error.message : "There is nothing to undo.",
    });
  return flashTo(ctx, "/explore", { message: undone.value.says });
}
