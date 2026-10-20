/**
 * Where one issue and one pull request live on an app's repository, and the
 * one rule for whether a viewer gets the studio at all on a repository.
 * Every studio surface — the app page, the asks, the lists, an issue, a
 * pull request, the search box and the palette — builds its links through
 * here, so the page a reader came from and the address bar they land in can
 * never disagree.
 *
 * Issues and pull requests are called that in every mode (#3241): the
 * studio once had its own nouns ("told", "changes") and its own addresses
 * for them, `/tells` and `/changes`. Those addresses now answer 301 to
 * `/issues` and `/pulls` (`src/http/server.ts`) so every link already
 * written to one keeps working; nothing here builds one any more.
 */

import { getAppByRepo, type AppRecord } from "../../core/apps.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";

/** The issues list (`tellsList`, `src/web/studio/lists.ts`). */
export const tellsHref = (base: string): string => `${base}/issues`;

/** The pull requests list (`changesList`, `src/web/studio/lists.ts`). */
export const changesHref = (base: string): string => `${base}/pulls`;

/** One issue (`tellPage`, `src/web/studio/tell.ts`). */
export const tellHref = (base: string, number: number): string =>
  `${base}/issues/${number}`;

/** One pull request (`pullPage`, `src/web/studio/change.ts`). */
export const changeHref = (base: string, number: number): string =>
  `${base}/pulls/${number}`;

/**
 * The one rule for whether a page speaks the studio's words on this repo:
 * whether it runs as an app — the same for every viewer, since there is one
 * forge and no mode (#603). A plain repository speaks git's.
 */
export function studioRecord(ctx: Ctx, repo: Repo): AppRecord | undefined {
  return getAppByRepo(ctx.app.db, repo.id);
}

/**
 * What each page a studio viewer can reach calls itself in the browser tab
 * — the bookmark, the history entry, the first thing a screen reader says
 * on arrival — decided here beside the addresses so a page never carries a
 * second literal of its own. Issues, pull requests, compose and settings
 * are one word in every mode (#3241); only the runs list still has two
 * faces: `studio` when `studioRecord` gives the page a studio, `dev` for
 * dev and any repository that is not an app. A single issue, pull request
 * or run titles itself by its own title, and the app page by the app's
 * name, so none of those is here.
 */
export const PAGE_TITLES = {
  tells: "Issues",
  changes: "Pull requests",
  runs: { studio: "Every run", dev: "Runs" },
  compose: "New issue",
  settings: "Settings",
} as const;

export type TitledPage = keyof typeof PAGE_TITLES;

/** A page's `<title>` noun and the repository it is about, in the face
 * the viewer has: `Issues · notes`, or `Every run · notes`. `studio`
 * decides only for a page with two faces (the runs list). */
export function pageTitle(
  which: TitledPage,
  repo: Repo,
  studio: boolean,
): string {
  const title = PAGE_TITLES[which];
  const word =
    typeof title === "string" ? title : title[studio ? "studio" : "dev"];
  return `${word} · ${repo.name}`;
}
