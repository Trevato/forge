/**
 * The app a run's own repository is: where its production and every open
 * pull's preview answer. A crew run on R may reach these from its shell —
 * an end-to-end check, a screenshot, the public launch check need the
 * running app — and no other repository's app: the URLs are made from R's
 * own slug and R's own pulls, never from a pattern a neighbour would match
 * (`notes--*` would cover `notes--3` and the app named `notes--3` alike).
 * Asked again for every invocation, like the rest of the sandbox, so a pull
 * opened between the work and the wrap-up is reachable in the second.
 */

import type { App } from "../app.ts";
import { previewEnv } from "../apps/data.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { type AppAccess, getAppByRepo } from "../core/apps.ts";
import { LIST_LIMIT_MAX } from "../core/issues.ts";
import { listPulls } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";

export interface OwnApp {
  /** Who may open it: a private app's door answers a signed-out request 404 by design (#10365). */
  readonly access: AppAccess;
  /** Production: the verified domain when there is one, else the slug's host. */
  readonly production: string;
  /** One preview per open pull, by number. */
  readonly previews: readonly { readonly number: number; readonly url: string }[];
}

/** Repo R's own app URLs, or undefined when R is not an app this forge serves. */
export function ownApp(app: App, repo: Repo): OwnApp | undefined {
  const record = getAppByRepo(app.db, repo.id);
  const runtime = appsRuntime(app);
  if (record === undefined || runtime === undefined) return undefined;
  const production = runtime.urlFor(record, "production");
  const previews = listPulls(app.db, repo.id, {
    state: "open",
    limit: LIST_LIMIT_MAX,
  })
    .map((pull) => ({
      number: pull.number,
      url: runtime.urlFor(record, previewEnv(pull.number)),
    }))
    .sort((a, b) => a.number - b.number);
  return { access: record.access, production, previews };
}

/** Every URL of `own`, for the sandbox to allow. */
export function ownAppUrls(own: OwnApp | undefined): string[] {
  if (own === undefined) return [];
  return [own.production, ...own.previews.map((p) => p.url)];
}
