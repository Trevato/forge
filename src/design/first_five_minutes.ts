/**
 * The first five minutes, as data: the words a stranger is never shown on the
 * path from a link to a change live, and the budgets that path keeps. The
 * journey is written in `docs/DESIGN.md` (§ The first five minutes); a test
 * imports these so the page and the list cannot drift.
 */

/** Words never shown to a stranger on the first-five-minutes path. Closed: a change here is a change to the doc. */
export const STRANGER_NEVER_SEES = ["subscription", "autonomy", "cell", "child", "claim"] as const;

/** The budgets, in screens and seconds. */
export const FIRST_FIVE_MINUTES = {
  screensBeforeForge: 3,
  forgeReadySeconds: 20,
  firstCrewActivitySeconds: 60,
  changeLiveSeconds: 300,
} as const;
