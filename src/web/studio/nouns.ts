/**
 * The studio's nouns: where one tell and one change live, and the one rule
 * for whether a viewer gets the studio at all on a repository. Every studio
 * surface — the app page, the asks, the lists, a tell, a change, the search
 * box and the palette — builds its links through here, so the page a reader
 * came from and the address bar they land in can never disagree about where
 * a tell lives.
 *
 * Dev's own addresses are never closed: `/issues/:number` and
 * `/pulls/:number` answer exactly as they always have, in both modes, so
 * every link already written to one keeps working forever. This is a second
 * door, not a replacement — and the doors that *change* something are not
 * here at all. A form still posts where it has always posted
 * (`/pulls/:number/ship`, `/issues/:number/comments`), which is what the
 * same-origin checks and `form-action 'self'` are written against.
 */

import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";

/** Everything told — the studio's own door onto `/issues`. */
export const tellsHref = (base: string): string => `${base}/tells`;

/** Every change — the studio's own door onto `/pulls`. */
export const changesHref = (base: string): string => `${base}/changes`;

/** One tell: the same page `/issues/:number` reaches, under the studio's
 * own noun (`tellPage`, `src/web/pages/issues.ts`). */
export const tellHref = (base: string, number: number): string =>
  `${base}/tells/${number}`;

/** One change: the same page `/pulls/:number` reaches, under the studio's
 * own noun (`changePage`, `src/web/pages/pull.ts`). */
export const changeHref = (base: string, number: number): string =>
  `${base}/changes/${number}`;

/**
 * The one rule for whether a viewer sees the studio's own page on this
 * repo: studio mode, no `?mode=dev` escape hatch, and an app to have a
 * studio word for — the same check `issuesList`/`pullsList` make before
 * falling back to dev's own list, and `issuePage`/`pullPage` before falling
 * back to dev's own page.
 */
export function studioRecord(ctx: Ctx, repo: Repo): AppRecord | undefined {
  const studio =
    ctx.mode === "studio" && ctx.url.searchParams.get("mode") !== "dev";
  return studio ? getAppByRepo(ctx.app.db, repo.id) : undefined;
}

/**
 * What each page a studio viewer can reach calls itself in the browser tab
 * — the bookmark, the history entry, the first thing a screen reader says
 * on arrival — in both faces, decided here beside the addresses so a page
 * never carries a second literal of its own. `studio` is the word when
 * `studioRecord` gives the page a studio; `dev` is today's word for dev and
 * for any repository that is not an app. A single tell, change or run
 * titles itself by its own title, and the app page by the app's name, so
 * none of those is here.
 */
export const PAGE_TITLES = {
  tells: { studio: "Everything told", dev: "Issues" },
  changes: { studio: "Every change", dev: "Pull requests" },
  runs: { studio: "Every run", dev: "Runs" },
  compose: { studio: "Tell the crew", dev: "New issue" },
  settings: { studio: "Settings", dev: "Settings" },
} as const;

export type TitledPage = keyof typeof PAGE_TITLES;

/** A page's `<title>` noun and the repository it is about, in the face
 * the viewer has: `Everything told · notes`, or `Issues · notes`. */
export const pageTitle = (
  which: TitledPage,
  repo: Repo,
  studio: boolean,
): string =>
  `${PAGE_TITLES[which][studio ? "studio" : "dev"]} · ${repo.name}`;
