/**
 * Talk builds an app, on the page (#11010): the one box on an empty Talk
 * ("What do you want to build?", with starters from the marked templates),
 * and beside a building conversation its versions, the chosen version's diff
 * with Restore, the preview, and Publish. All plain forms and links: it
 * ships no script.
 */

import { buildState, BUILD_WORDS, publishBuild, restoreVersion, startBuild, versionDiff, type BuildState } from "../actions/build.ts";
import { TALK_WORDS } from "../actions/talk.ts";
import { offeredTemplates } from "../core/app_templates.ts";
import { WORDS_MAX } from "../core/fence.ts";
import { getConversation } from "../core/conversations.ts";
import type { Database } from "bun:sqlite";
import type { Diff } from "../git/diff.ts";
import type { Ctx } from "../http/context.ts";
import { signInFirst, notFoundPage } from "./chrome.ts";
import { readForm } from "./form.ts";
import { html, type Html } from "./html.ts";
import { flashTo, redirect } from "./layout.ts";
import { btn, time } from "./ui.ts";
import type { User } from "../core/users.ts";

const TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ID = /^[0-9a-z]{1,40}$/;
/** Starters offered under the box. */
const STARTERS_MAX = 4;

/** The template the person chose with a starter link, if it is one on offer to them. */
export function chosenTemplate(db: Database, user: User, asked: string | null): string | undefined {
  return asked !== null && TEMPLATE.test(asked) && offeredTemplates(db, user).includes(asked) ? asked : undefined;
}

/** The empty Talk's one box: what to build, starters that choose a template, one Send. */
export function buildBox(db: Database, user: User, chosen: string | undefined): Html {
  const starters = offeredTemplates(db, user).slice(0, STARTERS_MAX);
  return html`<section class="talk-build-box" aria-labelledby="build-q">
    <h2 id="build-q">What do you want to build?</h2>
    <form method="post" action="/talk/build">
      ${chosen === undefined ? null : html`<input type="hidden" name="template" value="${chosen}" />`}
      <textarea class="input" name="prompt" rows="3" maxlength="${WORDS_MAX}" required aria-labelledby="build-q" placeholder="A tip calculator for friends"></textarea>
      <div class="bar">
        ${chosen === undefined ? null : html`<span class="small muted">Starting from ${chosen}</span>`}
        <span class="spacer"></span>
        ${btn("Build it", { variant: "primary" })}
      </div>
    </form>
    ${starters.length === 0
      ? null
      : html`<ul class="talk-build-starters small" aria-label="Start from">${starters.map((t) => html`<li><a href="/talk?template=${encodeURIComponent(t)}" ${t === chosen ? html`aria-current="true"` : null}>${t}</a></li>`)}</ul>`}
  </section>`;
}

/** What a diff changed, file by file; the lines themselves are one step deeper, on the pull. */
function diffHtml(diff: Diff): Html {
  return diff.files.length === 0
    ? html`<p class="small muted">This version changed no files.</p>`
    : html`<ul class="talk-build-files small">${diff.files.map((f) => html`<li><code>${f.path}</code> <span class="muted">${f.status}, +${f.additions} −${f.deletions}</span></li>`)}</ul>`;
}

/** The versions, the chosen one's diff and Restore, the preview, Publish. */
export function buildPanel(state: BuildState, base: string, chosen: number | undefined, diff: Diff | undefined): Html {
  const newest = state.versions.at(-1);
  return html`<aside class="talk-build" aria-label="The app being built" data-build>
    <p class="bar"><strong>${state.repoName}</strong>
      ${state.published
        ? html`<span class="badge">published</span>`
        : state.previewUrl === null
          ? html`<span class="small muted">${newest === undefined ? "No version yet: the first change makes v1." : "Preview is on its way."}</span>`
          : html`<a href="${state.previewUrl}" target="_blank" rel="noopener noreferrer">Preview${newest === undefined ? "" : ` v${newest.number}`}${state.previewState === null ? "" : ` (${state.previewState})`}</a>`}</p>
    ${state.productionUrl === null
      ? null
      : html`<p class="small"><a href="${state.productionUrl}" rel="noopener noreferrer">${state.productionUrl}</a></p>`}
    ${state.versions.length === 0
      ? null
      : html`<ol class="talk-build-versions" reversed aria-label="Versions">${[...state.versions].reverse().map(
          (v) => html`<li ${v.number === chosen ? html`aria-current="true"` : null}><a href="${base}?v=${v.number}">v${v.number}</a> ${v.subject} <span class="small muted">${time(v.date)}</span></li>`,
        )}</ol>`}
    ${chosen === undefined || diff === undefined
      ? null
      : html`<div class="talk-build-chosen"><div class="bar"><strong>v${chosen}</strong>
          <span class="spacer"></span>
          <form method="post" action="${base}/build/restore"><input type="hidden" name="version" value="${chosen}" />${btn("Restore", { label: `Make a new version from v${chosen}` })}</form></div>
          ${diffHtml(diff)}</div>`}
    ${state.published || state.versions.length === 0
      ? null
      : html`<form method="post" action="${base}/build/publish">${btn("Publish", { label: "Publish: merge to main and deploy production" })}</form>`}
  </aside>`;
}

/** The panel for a conversation that builds, or null when it does not (or is not the person's). */
export async function panelFor(ctx: Ctx, conversationId: string, base: string): Promise<Html | null> {
  const state = await buildState(ctx.app, ctx.auth.user, conversationId);
  if (!state.ok) return null;
  const v = Number(ctx.url.searchParams.get("v"));
  const chosen = Number.isInteger(v) && v >= 1 && state.value.versions.some((x) => x.number === v) ? v : undefined;
  const diff = chosen === undefined ? undefined : await versionDiff(ctx.app, ctx.auth.user, conversationId, chosen);
  return buildPanel(state.value, base, chosen, diff?.ok ? diff.value : undefined);
}

// POST /talk/build — one prompt makes the app and opens its chat.
export async function talkBuild(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const prompt = form.get("prompt");
  const template = form.get("template");
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > WORDS_MAX)
    return flashTo(ctx, "/talk", { tone: "danger", message: `Say what to build, up to ${WORDS_MAX} characters.` });
  const from = typeof template === "string" ? chosenTemplate(ctx.app.db, user, template) : undefined;
  const started = await startBuild(ctx.app, user, { prompt, ...(from === undefined ? {} : { template: from }) });
  if (!started.ok) return flashTo(ctx, "/talk", { tone: "danger", message: BUILD_WORDS[started.error] ?? "Not started." });
  const to = `/talk/${started.value.build.conversationId}`;
  return started.value.said === undefined ? redirect(to) : flashTo(ctx, to, { tone: "danger", message: `The app is made, but ${TALK_WORDS[started.value.said][1]}.` });
}

/** The conversation a build request names, when it is the person's. */
function mine(ctx: Ctx): string | undefined {
  const id = ctx.params["id"];
  return ctx.auth.user !== undefined && id !== undefined && ID.test(id) && getConversation(ctx.app.db, ctx.auth.user.id, id) !== undefined ? id : undefined;
}

// POST /talk/:id/build/restore
export async function talkRestore(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = mine(ctx);
  if (id === undefined) return notFoundPage(ctx);
  const n = Number(form.get("version"));
  const restored = Number.isInteger(n) && n >= 1 ? await restoreVersion(ctx.app, user, id, n) : undefined;
  return restored?.ok === true
    ? flashTo(ctx, `/talk/${id}`, { tone: "success", message: `Restored v${n} as a new version.` })
    : flashTo(ctx, `/talk/${id}`, { tone: "danger", message: BUILD_WORDS[restored?.ok === false ? restored.error : "no_version"] ?? "Not restored." });
}

// POST /talk/:id/build/publish
export async function talkPublish(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user === undefined) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const id = mine(ctx);
  if (id === undefined) return notFoundPage(ctx);
  const published = await publishBuild(ctx.app, user, id);
  return published.ok
    ? flashTo(ctx, `/talk/${id}`, { tone: "success", message: "Published. Production is deploying." })
    : flashTo(ctx, `/talk/${id}`, { tone: "danger", message: BUILD_WORDS[published.error] ?? "Not published." });
}

/** Styles for the box and the panel; added to Talk's own only on a page that draws one. Spacing is the 4px scale. */
export const buildCss = /* css */ `
.talk-build-box, .talk-build { max-width: min(48rem, 100%); margin: 0 auto 16px; display: grid; gap: 8px; }
.talk-build-box textarea { width: 100%; }
.talk-build-starters, .talk-build-versions, .talk-build-files { margin: 0; padding-left: 24px; }
.talk-build-starters { display: flex; flex-wrap: wrap; gap: 4px 16px; padding-left: 0; list-style: none; }
.talk-build-versions [aria-current] { font-weight: 600; }
`;
