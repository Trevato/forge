/**
 * `/packs` and `/packs/:name`: the forge packs this forge ships (`src/packs/`).
 * A pack's page says what it brings, the one command that deploys it on your
 * own machine, and a link to start a forge of your own. Server-rendered, no script; anyone may read it.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Pack } from "../../packs/pack.ts";
import { catalog, packNamed } from "../../packs/catalog.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { deployCommands } from "../../packs/words.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { copyField, row } from "../ui.ts";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The list of packs as rows; each row is one j/k stop. */
export const packsList = (packs: readonly Pack[]) =>
  html`<ul class="list">${packs.map((p) =>
      row({
        title: html`<a href="/packs/${p.name}">${p.title}</a>`,
        meta: html`${p.description} ${plural(p.apps.length, "app")}, ${plural(p.crew.length, "crew member")}.`,
        trail: html`v${p.version}`,
        nav: true,
      }),
    )}</ul>`;

// GET /packs
export function packsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const started = performance.now();
  const { packs } = catalog();
  const body = html`${pageHead("Forge packs", {
      sub: "A whole forge to start from: real apps with their history, and a crew set up to work on them.",
    })}
    ${packsList(packs)}`;
  const response = page({ ctx, title: "Forge packs", body });
  notePhase(ctx.request, "render", performance.now() - started);
  return response;
}

// GET /packs/:name
export function packPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const started = performance.now();
  const pack = packNamed(ctx.params.name ?? "");
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
