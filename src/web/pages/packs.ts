/**
 * `/packs` and `/packs/:name`: the forge packs this forge ships (`src/packs/`).
 * A pack's page says what it brings, the one command that deploys it on your
 * own machine, and how a person with no account can help build its apps and
 * what happens to their pull. Server-rendered, no script; anyone may read it.
 */

import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { catalog, packNamed } from "../../packs/catalog.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage, offersSignup, pageHead } from "../chrome.ts";
import { deployCommands, BRINGS_WORDS, STRANGER_WORDS } from "../../packs/words.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, listCard, row } from "../ui.ts";

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

// GET /packs
export function packsPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const started = performance.now();
  const { packs } = catalog();
  const body = html`${pageHead("Forge packs", {
      sub: "A whole forge to start from: real apps with their history, and a crew set up to work on them.",
    })}
    ${listCard(
      packs.map((p) =>
        row({
          title: html`<a href="/packs/${p.name}">${p.title}</a>`,
          meta: html`${p.description} ${plural(p.apps.length, "app")}, ${plural(p.crew.length, "crew member")}.`,
          trail: html`v${p.version}`,
        }),
      ),
    )}`;
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
  const signup = ctx.auth.user === undefined && offersSignup(ctx);
  const body = html`${pageHead(`${pack.title} pack`, { sub: `${pack.description} Version ${pack.version}.` })}
    ${card(
      html`${listCard(
          pack.apps.map((a) =>
            row({
              title: html`<a href="${a.source}" rel="noopener noreferrer">${a.name}</a>`,
              meta: html`${a.description}`,
            }),
          ),
        )}
        ${pack.crew.length === 0
          ? null
          : html`<h3>The crew it starts with</h3>
              ${listCard(pack.crew.map((c) => row({ title: c.username, meta: html`${c.roles.join(", ")}. ${c.brief}` })))}`}
        <p class="muted">${BRINGS_WORDS}</p>`,
      { head: html`<h2>What it brings</h2>` },
    )}
    ${card(
      html`<div class="stack stack-tight">
        ${deployCommands(pack, ctx.app.config.url).map((l) => html`<code class="mono break">${l}</code>`)}
      </div>`,
      { head: html`<h2>Deploy it on your own machine</h2>` },
    )}
    ${card(
      html`${STRANGER_WORDS.map((w) => html`<p>${w}</p>`)}
        <p>
          ${signup ? btn("Get an account", { href: "/signup", variant: "primary" }) : null}
          ${btn("Start your own forge", { href: "/forges/new" })}
        </p>`,
      { head: html`<h2>Help build these apps</h2>` },
    )}`;
  const response = page({ ctx, title: `${pack.title} pack`, body });
  notePhase(ctx.request, "render", performance.now() - started);
  return response;
}
