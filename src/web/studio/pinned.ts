/**
 * The panels a person pinned from /boards, drawn under home's KPI row in
 * their order (#2741), each with Up, Down and Unpin beside it. Only the
 * viewer's own pins are read. A pin whose board or panel is gone is skipped.
 */
import type { App } from "../../app.ts";
import { listPinned } from "../../actions/board-pins.ts";
import type { Pin } from "../../boards/pins.ts";
import type { User } from "../../core/users.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";
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

export async function pinnedPanels(app: App, user: User): Promise<Html | null> {
  const listed = await listPinned(app, user);
  if (!listed.ok || listed.value.length === 0) return null;
  return html`<section class="bgrid" aria-label="Pinned panels">${listed.value.map((p) => drawPanel(app, p.board, p.panel, controls(p)))}</section>`;
}
