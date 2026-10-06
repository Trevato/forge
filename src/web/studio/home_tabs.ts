/**
 * The home's three tabs on a phone — Feed, Your apps, Asked — drawn on each
 * of the three pages, so each is a tap from the others and never only the
 * logo away (#599, #851). Hidden on a desk, where the feed's own column and
 * links do the same work (`feed_style.ts`).
 */

import { html, raw, type Html } from "../html.ts";

export type HomeTab = "feed" | "apps" | "asked";

export function homeTabs(current: HomeTab): Html {
  const tab = (id: HomeTab, href: string, label: string) =>
    html`<a href="${href}" ${current === id ? raw('aria-current="page"') : null}>${label}</a>`;
  return html`<nav class="home-tabs seg" aria-label="Home">
    ${tab("feed", "/", "Feed")} ${tab("apps", "/apps", "Your apps")}
    ${tab("asked", "/asked", "Asked")}
  </nav>`;
}
