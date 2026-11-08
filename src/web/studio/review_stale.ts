/**
 * The `N stale, archive?` control: a form posting the stale asks to the
 * existing bulk-dismiss preview (`POST /asks/bulk`), which lists what would
 * change and asks again before anything is dismissed. One bulk step takes
 * `BULK_MAX` asks, so past that the label says it is the first of them.
 */

import { staleWords } from "../../flow/kpi_words.ts";
import { BULK_MAX } from "../../actions/asks_bulk.ts";
import { html, type Html } from "../html.ts";
import { btn } from "../ui.ts";

export function staleLabel(count: number): string {
  return count > BULK_MAX ? `First ${BULK_MAX} of ${staleWords(count)}` : staleWords(count);
}

export function staleArchive(stale: readonly { id: string }[]): Html {
  return html`<form method="post" action="/asks/bulk">
    <input type="hidden" name="action" value="dismiss" />${stale.slice(0, BULK_MAX).map((a) => html`<input type="hidden" name="item" value="${a.id}" />`)}
    ${btn(staleLabel(stale.length), { size: "sm", variant: "ghost" })}
  </form>`;
}
