/**
 * What the forge says about its releases, as plain data: what went live and
 * what is on its way, and the kept list. MCP `releases` and
 * `GET /api/v1/releases` both answer from here.
 */

import type { App } from "../app.ts";
import { getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { running } from "../kernel/version.ts";
import { BOOTED, mayRead } from "./gate.ts";
import { readLandings } from "./landings.ts";
import { listReleases, releaseName } from "./record.ts";

export const RELEASES_REFUSAL = "the release history is for the forge's administrators and its repository's readers";

export type ReleasesAnswer =
  | { ok: true; value: unknown }
  | { ok: false; error: "forbidden"; message: string };

/** What went live, for anyone: the list /changelog shows. */
export async function shippedAnswer(app: App) {
  const { version, commit, live, onItsWay } = await readLandings(app);
  return { version, commit, live, onItsWay };
}

/** The kept releases newest first, for whoever may read /releases; others get its refusal. */
export function releasesAnswer(app: App, user: User | undefined): ReleasesAnswer {
  if (!mayRead(app, user)) return { ok: false, error: "forbidden", message: RELEASES_REFUSAL };
  const live = running();
  return {
    ok: true,
    value: {
      items: listReleases(app.db).map((r) => {
        const isLive = live.commit !== null && r.sha === live.commit;
        const repo = getRepoById(app.db, r.repoId);
        return {
          sha: releaseName(r),
          version: isLive ? live.version : null,
          pull: r.pullNumber === null ? null : { repo: repo === undefined ? null : `${repo.ownerName}/${repo.name}`, number: r.pullNumber },
          landed: r.createdAt,
          ok: r.ok,
          ...(isLive ? { live: true, since: BOOTED } : {}),
        };
      }),
    },
  };
}
