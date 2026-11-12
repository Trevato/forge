/**
 * The search the sentinel probes (`/search?q=a`), read once behind the
 * listener so the first visit after a release does not pay for it (#11059).
 * A budgeted page search abandons its cold greps and never caches them, so
 * without this the first visitor of a fresh process finds every repository
 * cold. Here the grep is unbudgeted: each answer lands in the grep cache and
 * the next visit is served from it. Like `warmDisplays`, it runs as a
 * stranger, so only what anyone may read is warmed. The probe's own `q=a`
 * greps no code (`MIN_CODE_QUERY`, #11120), so the warm asks a query long
 * enough to grep: it reads the same database halves and fills the grep cache.
 */

import type { App } from "../app.ts";
import { search } from "../actions/search.ts";

/** A query long enough to grep (`MIN_CODE_QUERY`), so the warm fills the grep cache. */
export const WARM_QUERY = "an";

/** Fill the caches a first search reads. Never throws: a warm that fails is a cold first visit, nothing more. */
export async function warmSearch(app: App, q: string = WARM_QUERY): Promise<void> {
  try {
    await search(app, undefined, { q });
  } catch (error) {
    app.log.error("search warm failed", { error: String(error) });
  }
}
