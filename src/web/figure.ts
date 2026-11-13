/**
 * A figure: one number with its name above it and a sentence of what it means
 * under it, a link to where the number comes from, and a tiny trend where the
 * data has one. The home's strip, the boards, the flow page and the data page
 * all draw their figures here, so a number reads the same on each
 * (docs/design/areas/home-flow.md, `.hf-figs`).
 */
import { grouped } from "../boards/chart.ts";
import { html, type Html } from "./html.ts";

/** A count as a person reads it: 1,234. */
export const count = (n: number): string => grouped(n, 3);

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

/**
 * A page whose picture is not read yet says so, and its script asks for the
 * picture once (`src` answers when the worker has it) and then draws the page:
 * no timer, one request. Without scripts the sentence is a link to try again.
 */
export function reading(words: string, src: string, again: string): Html {
  return html`<p class="bd-lead" data-reading-src="${src}" aria-busy="true">${words}</p>
    <noscript><p><a href="${again}">Show it now</a></p></noscript>`;
}
/** A page whose picture could not be read says so plainly, with why and the way to try again. */
export function readingFailed(why: string, again: string): Html {
  return html`<p class="bd-lead" role="alert">The forge could not read this page just now.</p>
    <p>${why}</p>
    <p><a class="btn" href="${again}">Try again</a></p>`;
}
export const readingJs = /* js */ `
(function () {
  var r = document.querySelector('[data-reading-src]');
  if (!r || !window.fetch) return;
  fetch(r.getAttribute('data-reading-src'), { credentials: 'same-origin' })
    .then(function (x) { if (x.ok) location.replace(location.pathname); })
    .catch(function () {});
})();
`;
/** The same, for a page whose address carries its question: it draws the address the sentence links to. */
export const readingReplaceJs = /* js */ `
(function () {
  var r = document.querySelector('[data-reading-src]');
  if (!r || !window.fetch) return;
  var src = r.getAttribute('data-reading-src');
  fetch(src, { credentials: 'same-origin' })
    .then(function (x) { if (x.ok) location.replace(src.replace(/&wait=1$/, '')); })
    .catch(function () {});
})();
`;

/** A section closed until asked for: its name, one sentence of how it stands now, and the detail inside. */
export function fold(title: string, state: Html | string, body: Html, o: { id?: string; open?: boolean } = {}): Html {
  return html`<details class="disclosure fold" ${o.id === undefined ? null : html`id="${o.id}"`} ${o.open === true ? html`open` : null}>
    <summary><h2 class="fold-title">${title}</h2><span class="fold-state">${state}</span></summary>
    <div class="fold-body">${body}</div>
  </details>`;
}
