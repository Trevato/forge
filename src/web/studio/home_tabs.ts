/**
 * The home's three tabs on a phone — Feed, Your apps, Asked — drawn on each
 * of the three pages, so each is a tap from the others and never only the
 * logo away (#599, #851). Drawn with §5's tabs; the old `.home-tabs` rules in
 * `feed_style.ts` go in part two (#4224).
 */

import { html, type Html } from "../html.ts";
import { tabs } from "../ui.ts";

export type HomeTab = "feed" | "apps" | "asked";

/** §5's `tabs()` in a `.mb` block: link tabs, so `aria-current`. */
export function homeTabs(current: HomeTab): Html {
  const item = (id: HomeTab, href: string, label: string) => ({
    label,
    href,
    current: current === id,
  });
  return html`<div class="mb">
    ${tabs(
      [item("feed", "/", "Feed"), item("apps", "/apps", "Your apps"), item("asked", "/asked", "Asked")],
      "Home",
    )}
  </div>`;
}
