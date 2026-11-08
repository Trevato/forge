/**
 * The home's three tabs on a phone — Feed, Your apps, Asked — drawn on each
 * of the three pages, so each is a tap from the others and never only the
 * logo away (#599, #851). Drawn with §5's tabs.
 */

import type { Database } from "bun:sqlite";
import { askedCounts, askedRepos } from "../../core/asked.ts";
import type { User } from "../../core/users.ts";
import { html, type Html } from "../html.ts";
import { tabs } from "../ui.ts";

export type HomeTab = "feed" | "apps" | "asked";

/** The asks not yet shipped across the viewer's repositories: `/asked`'s own number. */
export function unshippedAsks(db: Database, viewer: User): number {
  return askedCounts(db, askedRepos(db, viewer, null)).unshipped;
}

/** §5's `tabs()` in a `.mb` block: link tabs, so `aria-current`; Asked wears the unshipped count. */
export function homeTabs(current: HomeTab, unshipped = 0): Html {
  const item = (id: HomeTab, href: string, label: string, count?: number) => ({
    label,
    ...(count === undefined ? {} : { count }),
    href,
    current: current === id,
  });
  return html`<div class="mb">
    ${tabs(
      [item("feed", "/feed", "Feed"), item("apps", "/apps", "Your apps"), item("asked", "/asked", "Asked", unshipped)],
      "Home",
    )}
  </div>`;
}
