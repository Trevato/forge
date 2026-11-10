/**
 * The search the sentinel probes (`/search?q=a`), read once behind the
 * listener so the first visit after a release does not pay for it (#11059).
 * A budgeted page search abandons its cold greps and never caches them, so
 * without this the first visitor of a fresh process finds every repository
 * cold. Here the grep is unbudgeted: each answer lands in the grep cache and
 * the next visit is served from it. Like `warmDisplays`, it runs as a
 * stranger, so only what anyone may read is warmed.
 */

import type { App } from "../app.ts";
import { search } from "../actions/search.ts";

/** The query the release probe asks, and so the one worth having warm. */
export const WARM_QUERY = "a";

/** Fill the caches a first search reads. Never throws: a warm that fails is a cold first visit, nothing more. */
export async function warmSearch(app: App, q: string = WARM_QUERY): Promise<void> {
  try {
    await search(app, undefined, { q });
  } catch (error) {
    app.log.error("search warm failed", { error: String(error) });
  }
}
