/**
 * Chapters (#11603): `/:owner/:name/chapters` lists the open chapter, the drafts after it and the
 * closed ones; `/:owner/:name/chapters/:chapter` is the list being crossed off — done items struck
 * through with the day they went live, what is building, what is left, the date at the current pace —
 * or, once closed, the one page that says it is finished. Server-rendered, no script; every change
 * is a same-origin POST by a person who administers the repository.
 */

import { CHAPTER_WORDS, close, draft, fill, open, patch } from "../../actions/chapters.ts";
import { getChapter, itemsOf, listChapters, progressOf, type Chapter, type Item } from "../../core/chapters.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, row } from "../ui.ts";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const day = (iso: string | null): string => (iso === null ? "" : iso.slice(0, 10));

const isOwner = (ctx: Ctx, repo: Repo): boolean =>
  ctx.auth.user !== undefined && ctx.auth.user.kind !== "agent" && canAdmin(ctx.app.db, repo, ctx.auth.user);

const hrefOf = (repo: Repo, c: Chapter): string => `${repoBase(repo)}/chapters/${encodeURIComponent(c.name)}`;

const STATE_WORDS = { open: "open", draft: "waiting its turn", closed: "closed" } as const;

function itemRow(repo: Repo, i: Item, may: boolean, chapter: Chapter): Html {
  const title = html`<a href="${repoBase(repo)}/issues/${i.number}">#${i.number}</a> ${i.status === "done" ? html`<s>${i.title}</s>` : i.title}`;
  const trail =
    i.status === "done"
      ? badge(`live ${day(i.doneAt)}`, { tone: "success" })
      : i.status === "building"
        ? badge("building now")
        : badge("left", { variant: "outline" });
  const out =
    may && chapter.state !== "closed"
      ? html`<form method="post" action="${hrefOf(repo, chapter)}/remove"><input type="hidden" name="number" value="${String(i.number)}">${btn("Take out", { variant: "ghost" })}</form>`
      : null;
  return html`<li data-item="${String(i.number)}" data-status="${i.status}">${row({ title, trail })}${out}</li>`;
}

// GET /:owner/:name/chapters
export function chaptersPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const may = isOwner(ctx, repo);
  const all = listChapters(ctx.app.db, repo.id);
  const rendering = performance.now();
  const rows = all.map((c) =>
    row({
      href: hrefOf(repo, c),
      nav: true,
      title: html`${c.name}${c.means === "" ? null : html` — ${c.means}`}`,
      trail: badge(STATE_WORDS[c.state], { tone: c.state === "open" ? "success" : "default" }),
    }),
  );
  const make = may
    ? html`<h2>Draft a chapter</h2>
        <form method="post" action="${repoBase(repo)}/chapters" class="bar">
          <input class="input" name="name" placeholder="v1.0.0" aria-label="Name" required maxlength="40">
          <input class="input" name="means" placeholder="What done means, in one sentence" aria-label="What done means" maxlength="300">
          ${btn("Draft", { variant: "primary" })}
        </form>`
    : null;
  const body = html`${repoHeader(ctx, repo, "issues")}
    ${pageHead("Chapters", { sub: "A chapter is a version with an end: finished, tagged and closed." })}
    ${all.length === 0 ? html`<p>No chapter yet: the crew works continuously. Draft one to say what v1 is.</p>` : html`<ul class="list setting-list">${rows}</ul>`}
    ${make}`;
  const response = page({ ctx, title: `Chapters · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

const fact = (name: string, value: string): Html => html`<div class="status-row"><dt>${name}</dt><dd>${value}</dd></div>`;

function finished(repo: Repo, c: Chapter, items: readonly Item[], may: boolean): Html {
  const done = items.filter((i) => i.status === "done");
  const days = c.openedAt === null || c.closedAt === null ? 0 : Math.max(1, Math.round((Date.parse(c.closedAt) - Date.parse(c.openedAt)) / 86_400_000));
  return html`<p data-finished><strong>${c.name} is finished.</strong> ${c.means}</p>
    <dl class="status-rows">
      ${fact("Shipped", `${done.length} ${done.length === 1 ? "item" : "items"}`)}
      ${fact("Took", `${days} ${days === 1 ? "day" : "days"}`)}
      ${fact("Cost", usd(c.costUsd ?? 0))}
      ${fact("Tag", `${c.name} ${(c.tagOid ?? "").slice(0, 8)}`)}
    </dl>
    <h2>Notes</h2>
    <pre data-notes>${c.notes}</pre>
    ${may
      ? html`<form method="post" action="${hrefOf(repo, c)}/patch">${btn(`Open a patch chapter for ${c.name}`, { variant: "primary" })}</form>`
      : null}`;
}

// GET /:owner/:name/chapters/:chapter
export function chapterPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const c = getChapter(ctx.app.db, repo.id, ctx.params.chapter ?? "");
  if (c === undefined) return notFoundPage(ctx);
  const may = isOwner(ctx, repo);
  const items = itemsOf(ctx.app.db, c);
  const p = progressOf(c, items, new Date());
  const rendering = performance.now();
  const here = hrefOf(repo, c);
  let main: Html;
  if (c.state === "closed") main = finished(repo, c, items, may);
  else {
    const building = items.filter((i) => i.status === "building");
    const left = items.filter((i) => i.status === "left");
    const done = items.filter((i) => i.status === "done");
    main = html`<p>${c.means}</p>
      <p data-progress>${p.done} of ${p.total} done${p.finishesOn === null ? "" : `; at this pace it finishes ${p.finishesOn}`}.</p>
      ${items.length === 0 ? html`<p>No issues in this chapter yet.</p>` : null}
      <ul class="list setting-list">${[...done, ...building, ...left].map((i) => itemRow(repo, i, may, c))}</ul>
      ${may
        ? html`<form method="post" action="${here}/add" class="bar">
            <input class="input" name="number" inputmode="numeric" pattern="[0-9]+" placeholder="Issue number" aria-label="Issue number" required>
            ${btn("Add to chapter")}
          </form>
          ${c.state === "draft" ? html`<form method="post" action="${here}/open">${btn("Open this chapter", { variant: "primary" })}</form>` : null}
          ${c.state === "open"
            ? html`<form method="post" action="${here}/ship">${btn(p.done === p.total && p.total > 0 ? "Close the book" : `Ship it, move ${p.total - p.done} to the next`, { variant: "primary" })}</form>`
            : null}`
        : null}`;
  }
  const body = html`${repoHeader(ctx, repo, "issues")}
    ${pageHead(c.name, { sub: STATE_WORDS[c.state] })}
    ${main}
    <p><a href="${repoBase(repo)}/chapters">All chapters</a></p>`;
  const response = page({ ctx, title: `${c.name} · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** What a chapter act answers: the page it stays on, with a flash. */
export async function chapterAct(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const list = `${repoBase(repo)}/chapters`;
  const name = ctx.params.chapter;
  const user = ctx.auth.user;
  if (user === undefined) return flashTo(ctx, list, { tone: "danger", message: "Sign in first." });
  const app = ctx.app;
  if (name === undefined) {
    const made = draft(app, user, repo, { name: field(form, "name"), means: field(form, "means") });
    return made.ok
      ? flashTo(ctx, hrefOf(repo, made.value), { message: `Drafted ${made.value.name}.` })
      : flashTo(ctx, list, { tone: "danger", message: CHAPTER_WORDS[made.error] });
  }
  const at = `${list}/${encodeURIComponent(name)}`;
  const verb = ctx.params.verb ?? "";
  const number = Number(field(form, "number"));
  const result =
    verb === "open" ? open(app, user, repo, name)
      : verb === "add" || verb === "remove" ? fill(app, user, repo, name, number, verb === "add")
      : verb === "ship" ? await close(app, user, repo, name, true)
      : verb === "patch" ? patch(app, user, repo, name)
      : null;
  if (result === null) return notFoundPage(ctx);
  if (!result.ok) return flashTo(ctx, at, { tone: "danger", message: CHAPTER_WORDS[result.error] });
  const landed = verb === "patch" && result.value !== undefined ? `${list}/${encodeURIComponent(result.value.name)}` : at;
  return flashTo(ctx, landed, { message: verb === "ship" ? `${name} is shipped.` : "Done." });
}
