/**
 * The Cores row on a sized forge's /settings (#11694): one `div` row for its admins, placed in the Plan row's `dl`;
 * null for anyone else or a forge no cell holds.
 */

import { html, type Html } from "./html.ts";

export function coresRow(admin: boolean, line: string | undefined): Html | null {
  if (!admin || line === undefined) return null;
  return html`<div class="status-row" data-cores><dt>Cores</dt><dd>${line}</dd></div>`;
}
