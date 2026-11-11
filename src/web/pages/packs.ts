/**
 * `/packs` and `/packs/:name`: the forge packs this forge ships (`src/packs/`).
 * A pack's page says what it brings, the one command that deploys it on your
 * own machine, and a link to start a forge of your own. Server-rendered, no script; anyone may read it.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Pack } from "../../packs/pack.ts";
import { refreshCatalogQuietly } from "../../packs/catalog.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { deployCommands } from "../../packs/words.ts";
import { html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { mirrorPacks, reportWords } from "../../packs/mirror.ts";
import { btn, copyField, field as uiField, row, timeAgo } from "../ui.ts";
import { listReposVisibleTo } from "../../core/repos.ts";
import { changeRepos, editPack, getPack, history, listPacks, mayCurate, resolveRepos, slugOf, type CuratedPack, type PackRepo } from "../../packs/curated.ts";
import { field, readForm } from "../form.ts";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The list of deployable packs (a pack.json in a repo) as rows; each row is one j/k stop. */
export const packsList = (packs: readonly Pack[]) =>
  html`<ul class="list">${packs.map((p) =>
      row({
        title: html`<a href="/packs/${p.name}">${p.title}</a>`,
        meta: html`${p.description} ${plural(p.apps.length, "app")}, ${plural(p.crew.length, "crew member")}.`,
        trail: html`v${p.version}`,
        nav: true,
      }),
    )}</ul>`;

/** A pack pushed to its repo shows within this long. */
const CATALOG_FRESH_MS = 2_000;

const admin = (ctx: Ctx): boolean => mayCurate(ctx.auth.user);

/** The newest push among a pack's shown repos, as "3d ago", or a plain "no pushes yet". */
const freshness = (repos: readonly PackRepo[]): string => {
  const newest = repos.map((r) => r.pushedAt).filter((t): t is string => t !== null).sort().pop();
  return newest === undefined ? "no pushes yet" : `updated ${timeAgo(newest)}`;
};

/** One repo of a pack: its name, what it is, and the live link when it runs here. */
const repoRow = (r: PackRepo) =>
  row({
    title: html`<a href="/${r.full}">${r.full.split("/")[1]}</a>`,
    meta: html`${r.description === "" ? "No description yet." : r.description}`,
    trail: r.live ? html`<a href="/${r.full}/app/production/open" rel="nofollow">Open live</a>` : html`<span class="muted small">not running</span>`,
  });

/** The one accent of a pack's own page; on the list it is plain, so a page has one primary. */
const startButton = (pack: CuratedPack, primary: boolean) =>
  btn("Start a forge from this", { href: `/forges/new?pack=${encodeURIComponent(pack.name)}`, ...(primary ? { variant: "primary" as const } : {}) });

function packCard(ctx: Ctx, pack: CuratedPack) {
  const repos = resolveRepos(ctx.app.db, pack, ctx.auth.user);
  const shown = repos.filter((r) => r.left === undefined);
  return html`<section class="stack" id="pack-${pack.name}">
    <h2><a href="/packs/${pack.name}">${pack.title}</a></h2>
    <p>${pack.pitch}</p>
    <p class="muted small">${plural(shown.length, "repo")}, ${freshness(shown)}.</p>
    <ul class="list">${shown.slice(0, 4).map(repoRow)}</ul>
    ${shown.length > 4 ? html`<p class="muted small"><a href="/packs/${pack.name}">All ${shown.length} repos</a></p>` : null}
    <div class="form-actions">${startButton(pack, false)}</div>
  </section>`;
}

/** What a pack is, in one sentence. */
const WHAT_IS_A_PACK = "A pack is a short list of repos on this forge that start together: start a forge from one and you get a copy of each repo and a crew briefed for them.";

// GET /packs
export async function packsPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const started = performance.now();
  const { packs } = await refreshCatalogQuietly(ctx.app, CATALOG_FRESH_MS);
  const curated = listPacks(ctx.app.db);
  const body = html`${pageHead("Packs", { sub: WHAT_IS_A_PACK })}
    ${curated.length === 0
      ? html`<section class="stack">
          <h2>No packs yet</h2>
          ${admin(ctx) ? html`<p>Make one from the repos you already have.</p>` : html`<p class="muted">An admin makes the first one.</p>`}
        </section>`
      : html`<div class="stack">${curated.map((p) => packCard(ctx, p))}</div>`}
    ${admin(ctx)
      ? html`<form class="stack" method="post" action="/packs/new">
          <h2>${curated.length === 0 ? "Make one from these repos" : "New pack"}</h2>
          ${uiField({ label: "Title", name: "title", required: true, placeholder: "Business" })}
          <div class="form-actions">${btn("New pack")}</div>
        </form>`
      : null}
    ${packs.length === 0 && !admin(ctx)
      ? null
      : html`<section class="stack">
          <h2>Deploy on your own machine</h2>
          ${packsList(packs)}
          ${admin(ctx)
            ? html`<form class="stack" method="post" action="/packs/mirror">
                <p class="muted small">Copy each of these packs' upstream projects here as read-only repositories that keep up with the original.</p>
                ${btn("Mirror the upstreams", { size: "sm", label: "Mirror the packs' upstreams" })}
              </form>`
            : null}
        </section>`}`;
  const response = page({ ctx, title: "Packs", body });
  notePhase(ctx.request, "render", performance.now() - started);
  return response;
}

const stamp = (iso: string): string => iso.slice(0, 16).replace("T", " ");

function editSection(ctx: Ctx, pack: CuratedPack, repos: readonly PackRepo[]) {
  const mine = new Set(pack.repos);
  const options = listReposVisibleTo(ctx.app.db, ctx.auth.user, { limit: 200, withoutArchived: true })
    .filter((r) => r.visibility === "public" && !mine.has(`${r.ownerName}/${r.name}`.toLowerCase()));
  const action = `/packs/${pack.name}/repos`;
  return html`<section class="stack">
    <h2>Edit this pack</h2>
    <form class="stack" method="post" action="/packs/${pack.name}/edit">
      ${uiField({ label: "Title", name: "title", value: pack.title, required: true })}
      ${uiField({ label: "Pitch", name: "pitch", value: pack.pitch, hint: "One line: what you get." })}
      ${uiField({ label: "Crew brief", name: "brief", type: "textarea", rows: 4, value: pack.brief, hint: "What the crew of a forge started from this pack is told." })}
      <div class="form-actions">${btn("Save")}</div>
    </form>
    <h3>Repos, in the order the cards show</h3>
    <ul class="list">${repos.map((r, i) =>
        row({
          title: html`<span class="mono">${r.full}</span>`,
          meta: html`${r.left ?? (r.description === "" ? "Shown." : r.description)}`,
          trail: html`<form method="post" action="${action}" class="form-actions">
            <input type="hidden" name="repo" value="${pack.repos[i]}" />
            ${i > 0 ? btn("↑", { name: "op", value: "up", size: "sm", variant: "ghost", label: `Move ${r.full} up` }) : null}
            ${i < repos.length - 1 ? btn("↓", { name: "op", value: "down", size: "sm", variant: "ghost", label: `Move ${r.full} down` }) : null}
            ${btn("Remove", { name: "op", value: "remove", size: "sm", variant: "ghost", label: `Remove ${r.full}` })}
          </form>`,
        }),
      )}</ul>
    <form class="stack" method="post" action="${action}">
      <input type="hidden" name="op" value="add" />
      <label class="field"><span>Add a repo</span>
        <input class="input mono" name="repo" list="pack-repo-options" autocomplete="off" spellcheck="false" placeholder="Type to search: owner/name" required />
      </label>
      <datalist id="pack-repo-options">${options.map((r) => html`<option value="${r.ownerName}/${r.name}"></option>`)}</datalist>
      <div class="form-actions">${btn("Add")}</div>
    </form>
  </section>`;
}

function curatedPage(ctx: Ctx, pack: CuratedPack, legacy: Pack | undefined): Response {
  const repos = resolveRepos(ctx.app.db, pack, ctx.auth.user);
  const shown = repos.filter((r) => r.left === undefined);
  const left = repos.filter((r) => r.left !== undefined);
  const past = admin(ctx) ? history(ctx.app.db, pack.name) : [];
  const commands = legacy === undefined ? [] : deployCommands(legacy, ctx.app.config.url);
  const body = html`${pageHead(`${pack.title} pack`, { sub: pack.pitch })}
    <p class="muted small">${plural(shown.length, "repo")}, ${freshness(shown)}.</p>
    <div class="form-actions">${startButton(pack, true)}</div>
    ${legacy === undefined
      ? null
      : html`<section class="stack">
          <h2>Deploy it on your own machine</h2>
          ${copyField("pack-command", commands.join("\n"), `The command that deploys the ${legacy.title} pack`, "Copy the command", { lines: commands.length })}
          <p class="muted small">No data, secrets or variables come with it.</p>
        </section>`}
    <section class="stack">
      <h2>The apps inside</h2>
      <ul class="list">${shown.map(repoRow)}</ul>
      ${left.length === 0 || !admin(ctx) ? null : html`<p class="muted small">Left out for now: ${left.map((r) => `${r.full} (${r.left})`).join(", ")}.</p>`}
    </section>
    ${pack.brief === "" ? null : html`<section class="stack"><h2>The crew it starts with</h2><p>${pack.brief}</p></section>`}
    ${admin(ctx) ? editSection(ctx, pack, repos) : null}
    ${past.length === 0
      ? null
      : html`<section class="stack"><h2>History</h2>
          <ul class="list">${past.map((c) => row({ title: html`${c.actor} ${c.what}`, meta: html`${stamp(c.at)}` }))}</ul></section>`}`;
  return page({ ctx, title: `${pack.title} pack`, body });
}

// GET /packs/:name
export async function packPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const started = performance.now();
  const curated = getPack(ctx.app.db, ctx.params.name ?? "");
  if (curated !== undefined) {
    const legacy = (await refreshCatalogQuietly(ctx.app, CATALOG_FRESH_MS)).packs.find((p) => p.name === curated.name);
    const shown = curatedPage(ctx, curated, legacy);
    notePhase(ctx.request, "render", performance.now() - started);
    return shown;
  }
  const pack = (await refreshCatalogQuietly(ctx.app, CATALOG_FRESH_MS)).packs.find((p) => p.name === (ctx.params.name ?? ""));
  if (pack === undefined) return notFoundPage(ctx);
  const commands = deployCommands(pack, ctx.app.config.url);
  const body = html`${pageHead(`${pack.title} pack`, { sub: pack.description })}
    <section class="stack">
      <h2>Deploy it on your own machine</h2>
      ${copyField("pack-command", commands.join("\n"), `The command that deploys the ${pack.title} pack`, "Copy the command", {
        lines: commands.length,
      })}
      <p class="muted small">No data, secrets or variables come with it.</p>
    </section>
    <section class="stack">
      <h2>What it brings</h2>
      <ul class="list">${pack.apps.map((a) =>
          row({
            title: html`<a href="${a.source}" rel="noopener noreferrer">${a.name}</a>`,
            meta: html`${a.description}`,
          }),
        )}</ul>
      ${pack.crew.length === 0
        ? null
        : html`<h3>The crew it starts with</h3>
            <ul class="list">${pack.crew.map((c) => row({ title: c.username, meta: html`${c.roles.join(", ")}. ${c.brief}` }))}</ul>`}
    </section>
    <p class="muted small"><a href="/forges/new">Start your own forge</a> to help build these apps.</p>`;
  const response = page({ ctx, title: `${pack.title} pack`, body });
  notePhase(ctx.request, "render", performance.now() - started);
  return response;
}

// POST /packs/mirror (admin)
export async function packsMirror(ctx: Ctx): Promise<Response> {
  if (ctx.auth.user?.isAdmin !== true || ctx.auth.user.kind === "agent") return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const done = await mirrorPacks(ctx.app, ctx.auth.user);
  if (!done.ok) return notFoundPage(ctx);
  return flashTo(ctx, "/packs", { tone: done.value.failed.length > 0 ? "danger" : "success", message: reportWords(done.value) });
}

const refused = (ctx: Ctx, to: string, says: string): Response => flashTo(ctx, to, { tone: "danger", message: says });

// POST /packs/new (admin)
export async function packNew(ctx: Ctx): Promise<Response> {
  if (!admin(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const title = field(form, "title");
  const name = slugOf(title);
  const done = editPack(ctx.app.db, ctx.auth.user, name, { title, repos: [] }, true);
  return done.ok ? flashTo(ctx, `/packs/${name}`, { tone: "success", message: "Pack made. Add its repos below." }) : refused(ctx, "/packs", done.says);
}

// POST /packs/:name/edit (admin)
export async function packEdit(ctx: Ctx): Promise<Response> {
  if (!admin(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const name = ctx.params.name ?? "";
  const done = editPack(ctx.app.db, ctx.auth.user, name, { title: field(form, "title"), pitch: field(form, "pitch"), brief: field(form, "brief") });
  return done.ok ? flashTo(ctx, `/packs/${name}`, { tone: "success", message: "Saved." }) : refused(ctx, `/packs/${name}`, done.says);
}

// POST /packs/:name/repos (admin): add, remove, up, down
export async function packRepos(ctx: Ctx): Promise<Response> {
  if (!admin(ctx)) return notFoundPage(ctx);
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const name = ctx.params.name ?? "";
  const here = `/packs/${name}`;
  if (getPack(ctx.app.db, name) === undefined) return notFoundPage(ctx);
  const done = changeRepos(ctx.app.db, ctx.auth.user, name, field(form, "op"), field(form, "repo"));
  return done.ok ? flashTo(ctx, here, { tone: "success", message: "Saved." }) : refused(ctx, here, done.says);
}
