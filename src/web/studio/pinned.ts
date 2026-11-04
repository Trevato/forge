/**
 * The panels a person pinned from /boards, drawn under home's KPI row in
 * their order (#2741), each with Up, Down and Unpin beside it. Only the
 * viewer's own pins are read. A pin whose board or panel is gone is skipped.
 */
import type { App } from "../../app.ts";
import { listPinned, PINS_EVENT } from "../../actions/board-pins.ts";
import type { Board, Panel } from "../../boards/store.ts";
import type { Pin } from "../../boards/pins.ts";
import type { User } from "../../core/users.ts";
import type { Database } from "bun:sqlite";
import { listPins } from "../../boards/pins.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";
import { cachedPanel } from "./home_cache.ts";
import { runFor } from "../../boards/panel_data.ts";
import { drawPanel } from "../pages/boards-view.ts";

function controls(p: Pin): Html {
  const hidden = html`<input type="hidden" name="slug" value="${p.slug}" /><input type="hidden" name="title" value="${p.title}" /><input type="hidden" name="back" value="/" />`;
  return html`<div class="row-actions">
    <form method="post" action="/boards/move-pin" class="row-actions">${hidden}
      ${btn("Up", { size: "sm", name: "by", value: "-1", label: `Move ${p.title} up` })}
      ${btn("Down", { size: "sm", name: "by", value: "1", label: `Move ${p.title} down` })}
    </form>
    <form method="post" action="/boards/unpin-panel" class="row-actions">${hidden}${btn("Unpin", { size: "sm", label: `Unpin ${p.title}` })}</form>
  </div>`;
}

/** Admin only: the caller has checked. The answer is kept per panel definition (cache 5). */
const cached = (p: Pin & { board: Board; panel: Panel }): typeof runFor => (db, chart, query) =>
  cachedPanel(db, [p.slug, p.board.range, p.panel.title, chart, p.panel.query, query.step], () => runFor(db, chart, query));

export async function pinnedPanels(app: App, user: User): Promise<Html | null> {
  const listed = await listPinned(app, user);
  if (!listed.ok) return null;
  const shown = listed.value.length === 0 ? null : html`<section class="bgrid" aria-label="Pinned panels">${listed.value.map((p) => drawPanel(app, p.board, p.panel, { slug: p.slug, index: p.board.panels.indexOf(p.panel) }, controls(p), cached(p)))}</section>`;
  return pinsRegion(shown);
}

/** The live region the pins sit in: a pin, unpin or move from any door (the terminal too) redraws it from `/live/home/panels`. */
const pinsRegion = (inner: Html | null): Html =>
  html`<div id="home-pins" data-live="${PINS_EVENT}" data-live-src="/live/home/panels">${inner}</div>`;

/**
 * Home's place for the pins, right after the KPIs. Without a pin it is an
 * empty live region and takes no space (a pin made elsewhere fills it); with
 * one, an empty slot that the page's script fills from
 * `/live/home/panels` after first paint, so the charts never cost the paint.
 * The slot holds one panel row's height until the fragment lands (or
 * fails, or comes back empty), so nothing below it shifts. Without script
 * the noscript link opens the same fragment.
 */
export function pinnedSlot(db: Database, user: User): Html | null {
  if (!user.isAdmin || user.kind === "agent") return null;
  if (listPins(db, user.id).length === 0) return html`<div id="home-panels" class="home-panels-slot">${pinsRegion(null)}</div>`;
  return html`<div id="home-panels" class="home-panels-slot" data-refresh="/live/home/panels">${pinsRegion(null)}<noscript><p class="small muted"><a href="/live/home/panels">Open your pinned panels</a>.</p></noscript></div>`;
}
