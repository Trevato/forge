/**
 * The toolbar page's link to the app's other side: from a preview, production;
 * from production, the newest open preview the viewer may see. The viewer's
 * reach is `envsFor`'s (a private app shows a stranger nothing), the choice is
 * `sideOf`'s, and the address keeps this page's path: the other side's origin
 * joined to it as text, never resolved against it, so a `//` path stays on
 * the app.
 */

import { sideOf, type Side } from "../../apps/side.ts";
import { envPull } from "../../apps/data.ts";
import { appsRuntime, envsFor } from "../../apps/runtime.ts";
import type { AppRecord } from "../../core/apps.ts";
import { getIssuesByNumbers, numberKey } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import { mayView } from "../../core/sealed.ts";
import type { Ctx } from "../../http/context.ts";

/** `target` with the path of `address` (the page being viewed), or `target` alone. */
export function joinPath(target: string, address: string): string {
  const to = URL.parse(target);
  if (!to) return "";
  const path = URL.parse(address)?.pathname ?? "/";
  return `${to.origin}${path}`;
}

/** The other side for a viewer, or null: nothing to open, or nothing theirs to see. */
export function toolbarSide(
  ctx: Ctx,
  repo: Repo,
  record: AppRecord,
  environment: string,
  address: string,
): Side | null {
  const runtime = appsRuntime(ctx.app);
  if (runtime === undefined) return null;
  const envs = envsFor(ctx.app, ctx.auth.user, record);
  if (envs.length === 0) return null;
  const titles = new Map<number, string>();
  if (environment === "production") {
    const numbers = envs.flatMap((e) => envPull(e.env) ?? []);
    const found = getIssuesByNumbers(ctx.app.db, numbers.map((number) => ({ repoId: repo.id, number })));
    for (const number of numbers) {
      const issue = found.get(numberKey(repo.id, number));
      if (issue && issue.kind === "pull" && issue.state === "open" && mayView(ctx.app.db, repo, issue, ctx.auth.user))
        titles.set(number, issue.title);
    }
  }
  const previews = envs.flatMap((e) => {
    const n = envPull(e.env);
    const title = n === undefined ? undefined : titles.get(n);
    return n === undefined || title === undefined ? [] : [{ number: n, title, state: e.state, url: e.url }];
  });
  const side = sideOf({ url: runtime.urlFor(record, "production") }, environment, previews);
  if (side === null) return null;
  const url = joinPath(side.url, address);
  return url === "" ? null : { label: side.label, url };
}
