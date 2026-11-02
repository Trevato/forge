/**
 * Home's week line (#8695): one sentence on whether the crew is spending the
 * subscriptions' week on pace, and beside it what a real landing costs
 * (`weekWords`). Empty while no account's week has a known cap.
 */

import type { App } from "../../app.ts";
import { weekWords } from "../../crew/week_read.ts";
import { html, type Html } from "../html.ts";

export function weekLine(app: App, now: Date = new Date()): Html {
  const words = weekWords(app, now);
  return words === null ? html`` : html`<p class="small muted break">${words}</p>`;
}
