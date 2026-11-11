/**
 * A contacts file (`.vcf`, `.vcard`) as a readable list of people, one row
 * each: the name and organisation, with labelled email, phone, web and note
 * folded beneath. Every value is escaped by the template; a url or note is
 * shown as text, never as a link, so a `javascript:` value is inert.
 */

import { html, type Html } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";
import { CARD_CAP, parseVcf, type Card } from "./vcf-parse.ts";

const fact = (label: string, values: readonly string[]): Html | null =>
  values.length === 0 ? null : html`<div><dt>${label}</dt><dd>${values.join(", ")}</dd></div>`;

function row(c: Card): Html {
  const facts = [fact("Email", c.emails), fact("Phone", c.phones), fact("Web", c.urls), fact("Note", c.note === "" ? [] : [c.note])].filter(
    (f): f is Html => f !== null,
  );
  return html`<div class="status-row">
    <dt>${c.name}${c.org === "" ? "" : html` <span class="muted">${c.org}</span>`}</dt>
    <dd>${facts.length === 0 ? "" : html`<dl class="row-facts">${facts}</dl>`}</dd>
  </div>`;
}

export function vcf(input: RenderInput): Rendered {
  const parsed = parseVcf(new TextDecoder().decode(input.body));
  if ("error" in parsed) return { content: html``, lines: 0, fallback: `This file is not drawn as contacts: ${parsed.error}.` };
  if (parsed.total === 0) return { content: html``, lines: 0, fallback: "This contacts file holds no complete cards." };
  const more =
    parsed.total > CARD_CAP
      ? html`<p class="muted small">Showing first ${CARD_CAP.toLocaleString()} of ${parsed.total.toLocaleString()} contacts.</p>`
      : html``;
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const content = html`<dl class="status-rows" aria-label="${name} contacts">${parsed.cards.map(row)}</dl>${more}`;
  const n = parsed.total;
  return { content, lines: 0, summary: `${n.toLocaleString()} ${n === 1 ? "contact" : "contacts"} · ${fileSize(input.size)}` };
}
