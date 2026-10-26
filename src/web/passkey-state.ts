/**
 * The passkey on/off state, drawn as §5's badge. Whether a passkey can run is
 * known only in the browser, so the server renders "off" and `passkey-client.ts`
 * flips the badge to "on" (success) and swaps the `data-passkey="on"` /
 * `"off"` controls by the `hidden` attribute.
 */
import { html, type Html } from "./html.ts";
import { badge } from "./ui.ts";

/** The state word as a badge, quiet until the client finds a passkey can run. */
export function passkeyState(): Html {
  return html`<span data-passkey-state>${badge("Passkey off", { variant: "outline" })}</span>`;
}

/**
 * The line a passkey control reports to, in §5's field shape: quiet muted text
 * until a failure, then `.error` in a `.field`. `passkey-client.ts` toggles the
 * class named by `data-fail`; a page that re-rendered with a failure writes
 * the same shape itself.
 */
export function passkeyNote(id: string, error?: string): Html {
  return html`<div class="field"><span class="${error ? "error" : "muted small"}" id="${id}" data-fail="error" role="${error ? "alert" : "status"}">${error ?? ""}</span></div>`;
}
