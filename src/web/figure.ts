/**
 * A figure: one number with its name above it and a sentence of what it means
 * under it, a link to where the number comes from, and a tiny trend where the
 * data has one. The home's strip, the boards, the flow page and the data page
 * all draw their figures here, so a number reads the same on each
 * (docs/design/areas/home-flow.md, `.hf-figs`).
 */
import { html, type Html } from "./html.ts";

/** A count as a person reads it: 1,234. */
export const count = (n: number): string => n.toLocaleString("en-US");

export function figure(label: string, value: Html | string, note: Html | string, href: string, extra: Html | null = null, tone: "attn" | null = null): Html {
  return html`<a class="hf-fig" href="${href}" ${tone === null ? null : html`data-tone="${tone}"`}>
    <span class="hf-fig-label">${label}</span>
    <span class="hf-fig-value num">${value}</span>
    <span class="hf-fig-note">${note}</span>
    ${extra === null ? null : html`<span class="hf-fig-spark">${extra}</span>`}
  </a>`;
}

/** A strip of figures: two across on a phone, all of them across from 720px (five unless `data-figs` says four). */
export function figures(figs: readonly Html[], label: string): Html {
  return html`<div class="hf-figs" role="group" aria-label="${label}" ${figs.length === 5 ? null : html`data-figs="${String(figs.length)}"`}>${[...figs]}</div>`;
}

/** A section closed until asked for: its name, one sentence of how it stands now, and the detail inside. */
export function fold(title: string, state: Html | string, body: Html, o: { id?: string; open?: boolean } = {}): Html {
  return html`<details class="disclosure fold" ${o.id === undefined ? null : html`id="${o.id}"`} ${o.open === true ? html`open` : null}>
    <summary><h2 class="fold-title">${title}</h2><span class="fold-state">${state}</span></summary>
    <div class="fold-body">${body}</div>
  </details>`;
}
