/**
 * The one `?` of a page: the explanations that change no decision, kept out of
 * the page so it answers at first sight. Closed until asked for, and open with
 * its summary focused when the URL says `?help`, so a look can picture it.
 */
import { html, type Html } from "./html.ts";

/** True when the request asks for the help open (`?help`). */
export const helpAsked = (url: string | URL): boolean => new URL(url, "http://forge.local").searchParams.has("help");

export const pageHelp = (notes: readonly (readonly [string, string | Html])[], open = false): Html =>
  html`<details class="disclosure mb" data-page-help${open ? html` open` : html``}>
    <summary${open ? html` autofocus` : html``}><span aria-hidden="true">?</span> Help</summary>
    <dl class="status-rows">
      ${notes.map(([name, text]) => html`<div class="status-row"><dt>${name}</dt><dd>${text}</dd></div>`)}
    </dl>
  </details>`;
