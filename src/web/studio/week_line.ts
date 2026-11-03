/**
 * Home's week (#8695, #8961): for the owner, the crew line (percent of the
 * week left, when it runs out at this pace), then the pace sentence without
 * those figures and beside it what a real landing costs (`weekWords`). Both
 * in the same muted small style, read as one block. Empty while no account
 * is metered.
 */

import type { App } from "../../app.ts";
import { crewLineWords, weekWords } from "../../crew/week_read.ts";
import { html, type Html } from "../html.ts";

type Viewer = { readonly isAdmin: boolean } | undefined;

/** The full pace sentence, for pages without the crew line (Spend). */
export function weekLine(app: App, now: Date = new Date()): Html {
  const words = weekWords(app, now);
  return words === null ? html`` : html`<p class="small muted break">${words}</p>`;
}

/** Home's week: the owner reads the crew line and the sentence under it, the percent said once; anyone else the full sentence. */
export function homeWeek(app: App, viewer: Viewer, now: Date = new Date()): Html {
  const crew = viewer?.isAdmin === true ? crewLineWords(app, now) : null;
  if (crew === null) return weekLine(app, now);
  const words = weekWords(app, now, true);
  return html`<p class="small muted break" id="crew-pace">${crew}</p>${words === null ? html`` : html`<p class="small muted break">${words}</p>`}`;
}
