/**
 * The combined card on a fork's pull (#9012): main merged into the author's
 * head on our side, which the preview builds and the landing merges, with
 * each conflicted file and what was kept. The terminal says the same
 * (`core/combined_view.ts`).
 */

import type { Pull } from "../../core/pulls.ts";
import { combinedView, combinedWords } from "../../core/combined_view.ts";
import { html, type Html } from "../html.ts";
import { card, icon } from "../ui.ts";

export async function combinedCard(
  dir: string,
  pull: Pull,
  headOid: string,
  baseOid: string,
): Promise<Html> {
  const view = await combinedView(dir, pull, headOid, baseOid);
  if (view === undefined) return html``;
  const words = combinedWords(view, pull.number);
  return card(
    html`<p>${words.lead}</p>
      ${words.files.length === 0 ? null : html`<ul>${words.files.map((i) => html`<li>${i}</li>`)}</ul>`}
      ${words.notes.map((w) => html`<p class="muted small">${w}</p>`)}`,
    {
      extra: "mb",
      head: html`${icon("merge")}
        <h2>Combined with main${view.stale ? " · stale" : ""}</h2>`,
    },
  );
}
