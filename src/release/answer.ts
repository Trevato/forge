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
import { chosenRepo, readLandings, type Landing, type Landings } from "./landings.ts";
import { listReleases, releaseName } from "./record.ts";

export const RELEASES_REFUSAL = "the release history is for the forge's administrators and its repository's readers";

export type ReleasesAnswer =
  | { ok: true; value: unknown }
  | { ok: false; error: "forbidden"; message: string };

/** Reads in flight, shared: concurrent anonymous requests cost git and the merged rows once. */
let reading: Promise<Landings> | undefined;
function readOnce(app: App): Promise<Landings> {
  reading ??= readLandings(app).finally(() => {
    reading = undefined;
  });
  return reading;
}

/**
 * What went live, for anyone: the list /changelog shows. `asked` is the
 * page's `?repo=`: "all" or `owner/name`; absent, or not a repository in the
 * list, is the forge's own, as on the page. Only public repositories are
 * ever read (`mergedRows`).
 */
export async function shippedAnswer(app: App, asked: string | null = null) {
  const read = await readOnce(app);
  const choice = chosenRepo(asked, [...read.onItsWay, ...read.live], read.own);
  const keep = (l: Landing) => choice === "all" || l.repo === choice;
  return { version: read.version, commit: read.commit, live: read.live.filter(keep), onItsWay: read.onItsWay.filter(keep) };
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
