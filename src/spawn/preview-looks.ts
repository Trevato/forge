/**
 * The looks every preview of the forge takes as its owner (#8974): home
 * with its pins, /flow, the seeded repository's head, its pull's page and
 * its Iterations page (#9182), the seeded app's page (#9782), the Later gate's proposal (#9212), its
 * milestones (#9326) and its waves (#9325), each at desk and phone width.
 * The looks service adds them to whatever forge.json lists for a preview
 * of the forge's own repository (`FORGE_REPO`), so no edit of forge.json can
 * drop one.
 *
 * Plain data and no imports beyond a type: the seed (`preview-seed.ts`)
 * makes what these pages show, and the looks service reads the list.
 */

import type { LookKind } from "../core/looks.ts";

/** The preview-only site admin's name. */
export const PREVIEW_ADMIN = "preview-admin";
/** The repository the admin's pages are about. */
export const PREVIEW_REPO = "sample";
/**
 * The seeded pull's number: two issues come first and share its count.
 * PREVIEW_OWNER_LOOKS names its page, so the seed refuses any other
 * number rather than leave that look on a 404.
 */
export const PREVIEW_PULL = 3;
/** The seeded repository's head, and its pull's page. */
export const PREVIEW_REPO_HOME = `/${PREVIEW_ADMIN}/${PREVIEW_REPO}`;
export const PREVIEW_PULL_PAGE = `${PREVIEW_REPO_HOME}/pulls/${String(PREVIEW_PULL)}`;

/** The pull's Files tab, whose diff holds a line comment that must not scroll sideways (#10073). */
export const PREVIEW_PULL_FILES = `${PREVIEW_PULL_PAGE}/files`;

/**
 * The seeded app: a second repository whose only app fact is its record, so
 * its home is the app page (#9782). Nothing runs: the page says so. The seed
 * refuses to finish unless that page answers 200.
 */
export const PREVIEW_APP = "hello";
export const PREVIEW_APP_PAGE = `/${PREVIEW_ADMIN}/${PREVIEW_APP}`;

/**
 * The recently moved repository (#10195): made by the admin as `moved`, then
 * moved to the first seeded fork owner through the action a person uses, so
 * its head draws "Moved from preview-admin/moved on <date>". The seed refuses
 * to finish unless the page answers 200 and holds the line.
 */
export const PREVIEW_MOVED = "moved";
export const PREVIEW_MOVED_OWNER = "preview-ada";
export const PREVIEW_MOVED_PAGE = `/${PREVIEW_MOVED_OWNER}/${PREVIEW_MOVED}`;

/** The Iterations page of the seeded fork family (#9182). */
export const PREVIEW_ITERATIONS_PAGE = `${PREVIEW_REPO_HOME}/iterations`;
/**
 * The seeded forks, in the order they are made: each is `<owner>/sample`, a
 * fork of the sample or of the fork whose owner is named by `of` (one person
 * forks a repository once). The seed refuses to finish if the page would not
 * draw them.
 */
export const PREVIEW_FORKS: readonly { readonly owner: string; readonly of?: string }[] = [
  { owner: "preview-ada" },
  { owner: "preview-bo" },
  { owner: "preview-cy" },
  { owner: "preview-dee", of: "preview-ada" },
];

/** The owner's bets page, whose seeded proposed bets hold the long-name worst case (#9275). */
export const PREVIEW_BETS_PAGE = `${PREVIEW_REPO_HOME}/bets`;

/** The owner's milestones page, seeded with one milestone; its phone look shows the fit (#9326). */
export const PREVIEW_MILESTONES_PAGE = `${PREVIEW_REPO_HOME}/milestones`;

/** The search page with a query the seed answers, whose phone look shows the fit (#9351). */
export const PREVIEW_SEARCH_PAGE = "/search?q=sample";

/** The waves page, whose long headlines must wrap at a 390 px phone (#9325). */
export const PREVIEW_WAVES_PAGE = `${PREVIEW_REPO_HOME}/waves`;

/** The issues list, whose long titles must wrap at a 390 px phone (#9344). */
export const PREVIEW_ISSUES_PAGE = `${PREVIEW_REPO_HOME}/issues`;

/** The pulls list, whose long titles must wrap at a 390 px phone (#9346). */
export const PREVIEW_PULLS_PAGE = `${PREVIEW_REPO_HOME}/pulls`;

/** The owner's resilience page, whose protections and test paths must wrap at a 390 px phone (#9328). */
export const PREVIEW_RESILIENCE_PAGE = "/resilience";

/** The changelog, whose long landing titles must wrap at a 390 px phone (#9349). */
export const PREVIEW_CHANGELOG_PAGE = "/changelog";

/** The next-up page, whose long titles and action buttons must fit a 390 px phone (#9324). */
export const PREVIEW_NEXT_PAGE = `${PREVIEW_REPO_HOME}/next`;

/** The sample's first issue, whose long title and comments must wrap at a 390 px phone (#9384). */
export const PREVIEW_ISSUE_PAGE = `${PREVIEW_REPO_HOME}/issues/1`;

/** The same issue with its Edit fold open, for its phone look (#10074). */
export const PREVIEW_ISSUE_EDIT_PAGE = `${PREVIEW_ISSUE_PAGE}?edit=1`;

/** The commits list, whose long messages must wrap at a 390 px phone (#9348). */
export const PREVIEW_COMMITS_PAGE = `${PREVIEW_REPO_HOME}/commits`;

/** The Later gate's proposal on the sample (#9212): what the gate holds, grouped by theme. */
export const PREVIEW_HELD_PAGE = `${PREVIEW_REPO_HOME}/held`;
/**
 * The seeded held issues: each theme is a word three titles share (the least
 * the triage groups on), and there are more themes than the page draws at
 * rest, so its fold line shows. Titles share no other word, so no issue
 * falls under "Other" or reads as another's duplicate.
 */
export const PREVIEW_HELD_THEMES: readonly { readonly theme: string; readonly titles: readonly string[] }[] = [
  { theme: "billing", titles: ["Billing shows a receipt", "Billing offers refunds", "Billing remembers cards"] },
  { theme: "search", titles: ["Search finds typos", "Search ranks fresh work", "Search saves queries"] },
  { theme: "mobile", titles: ["Mobile opens offline", "Mobile pulls to refresh", "Mobile shares sheets"] },
  { theme: "export", titles: ["Export writes archives", "Export schedules nightly", "Export signs bundles"] },
  { theme: "onboarding", titles: ["Onboarding greets newcomers", "Onboarding offers tours", "Onboarding tracks progress"] },
  { theme: "themes", titles: ["Themes follow daylight", "Themes allow contrast", "Themes preview swatches"] },
  { theme: "webhooks", titles: ["Webhooks retry deliveries", "Webhooks sign payloads", "Webhooks replay events"] },
  { theme: "digest", titles: ["Digest groups mentions", "Digest honours quiet hours", "Digest links threads"] },
];

/**
 * The owner's settings pages that list things (#9781): tokens, the crew,
 * subscriptions and usage. The seed gives each something to show and
 * refuses to finish if any would answer anything but 200.
 */
export const PREVIEW_SETTINGS_PAGES: readonly string[] = [
  "/settings/tokens",
  "/settings/crew",
  "/settings/subscriptions",
  "/settings/usage",
];

export interface OwnerLook {
  readonly page: string;
  readonly kind: LookKind;
}

/** The named list: each page at desk and phone, taken as the owner. */
export const PREVIEW_OWNER_LOOKS: readonly OwnerLook[] = [
  "/",
  "/flow",
  PREVIEW_REPO_HOME,
  PREVIEW_APP_PAGE,
  PREVIEW_MOVED_PAGE,
  PREVIEW_PULL_PAGE,
  PREVIEW_PULL_FILES,
  PREVIEW_ITERATIONS_PAGE,
  PREVIEW_HELD_PAGE,
  PREVIEW_BETS_PAGE,
  PREVIEW_MILESTONES_PAGE,
  PREVIEW_WAVES_PAGE,
  PREVIEW_PULLS_PAGE,
  PREVIEW_CHANGELOG_PAGE,
  PREVIEW_NEXT_PAGE,
  PREVIEW_COMMITS_PAGE,
  PREVIEW_ISSUES_PAGE,
  PREVIEW_ISSUE_PAGE,
  PREVIEW_ISSUE_EDIT_PAGE,
  PREVIEW_RESILIENCE_PAGE,
  PREVIEW_SEARCH_PAGE,
  ...PREVIEW_SETTINGS_PAGES,
].flatMap((page) => (["desktop", "phone"] as const).map((kind) => ({ page, kind })));

/**
 * The owner looks a picture of `repo`'s `env` must include: the named list
 * for a preview of the forge's own repository, none for anything else —
 * production is not seeded, and another app has no such pages.
 */
export function ownerLooksFor(
  forgeRepo: string | undefined,
  repo: { readonly ownerName: string; readonly name: string },
  env: string,
): readonly OwnerLook[] {
  return env !== "production" && forgeRepo !== undefined && forgeRepo === `${repo.ownerName}/${repo.name}`
    ? PREVIEW_OWNER_LOOKS
    : [];
}
