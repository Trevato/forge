/**
 * The line a passkey control reports to. Whether a passkey can run is known
 * only in the browser: `passkey-client.ts` shows the `data-passkey="on"`
 * controls and hides the `data-passkey="off"` ones by the `hidden` attribute,
 * so a page never says which state it is in, it just offers what works.
 */
import { html, type Html } from "./html.ts";

/**
 * The line a passkey control reports to, in §5's field shape: quiet muted text
 * until a failure, then `.error` in a `.field`. `passkey-client.ts` toggles the
 * class named by `data-fail`; a page that re-rendered with a failure writes
 * the same shape itself.
 */
export function passkeyNote(id: string, error?: string): Html {
  return html`<div class="field"><span class="${error ? "error" : "muted small"}" id="${id}" data-fail="error" role="${error ? "alert" : "status"}">${error ?? ""}</span></div>`;
}
