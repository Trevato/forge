/**
 * Home's week (#8695, #8961): the share of the week used, what the crew may
 * use, and beside it what a real landing costs (`weekWords`). Empty while no
 * account is metered.
 */

import type { App } from "../../app.ts";
import { weekWords } from "../../crew/week_read.ts";
import { html, type Html } from "../html.ts";

/** The week sentence, for Spend. */
export function weekLine(app: App, now: Date = new Date()): Html {
  const words = weekWords(app, now);
  return words === null ? html`` : html`<p class="small muted break">${words}</p>`;
}
