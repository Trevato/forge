/**
 * Who of the crew is working on an app right now, for the forge pill: the
 * running agent run on this app (production) or on this preview's pull, as
 * the name to show and the forge page to link. Only for a person the app
 * has admitted who may read the repository (and the pull); everyone else,
 * and an idle app, get nothing.
 */

import type { Database } from "bun:sqlite";
import type { AppRecord } from "../core/apps.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { timePhase } from "../core/route_timing.ts";
import { getIssue } from "../core/issues.ts";
import { canRead, canWrite, getRepoById } from "../core/repos.ts";
import { workingAgentRuns } from "../core/runs.ts";
import { mayView, mayViewId } from "../core/sealed.ts";
import { getUserById, isActive } from "../core/users.ts";

export type CrewNow = { who: string; url: string };

export function crewNow(
  db: Database,
  forgeUrl: string,
  app: AppRecord,
  env: string,
  viewerId: string | undefined,
  /** When given, the reads are named on it: `app`, `pull`, `working`. */
  request?: Request,
): CrewNow | undefined {
  return crewAll(db, forgeUrl, app, env, viewerId, request)[0];
}

/** Everyone working on the app now, by the same rules as `crewNow`. */
export function crewAll(
  db: Database,
  forgeUrl: string,
  app: AppRecord,
  env: string,
  viewerId: string | undefined,
  request?: Request,
): CrewNow[] {
  const phase = <T>(name: string, work: () => T): T =>
    request === undefined ? work() : timePhase(request, name, work);
  if (viewerId === undefined) return [];
  const seen = phase("app", () => {
    const viewer = getUserById(db, viewerId);
    const repo = getRepoById(db, app.repoId);
    if (viewer === undefined || !isActive(viewer) || repo === undefined) return undefined;
    if (!canRead(db, repo, viewer)) return undefined;
    return { viewer, repo };
  });
  if (seen === undefined) return [];
  const { viewer, repo } = seen;
  const number = /^pull-(\d+)$/.exec(env)?.[1];
  if (number === undefined && env !== "production") return [];
  const pulled = phase("pull", () => {
    if (number === undefined) return { issueId: undefined };
    const pull = getIssue(db, repo.id, Number(number));
    if (pull === undefined || !mayView(db, repo, pull, viewer)) return undefined;
    return { issueId: pull.id as string | undefined };
  });
  if (pulled === undefined) return [];
  // A run on a sealed issue is not the viewer's to know of.
  return phase("working", () =>
    workingAgentRuns(db, repo.id, pulled.issueId)
      .filter((r) => mayViewId(db, repo, r.issueId, viewer))
      .map((run) => {
        const actor = run.actorId === null ? undefined : getUserById(db, run.actorId);
        return {
          who: actor?.username ?? "the crew",
          url: new URL(`/${repo.ownerName}/${repo.name}/runs/${run.id}`, forgeUrl).href,
        };
      }),
  );
}

/**
 * The forge page that says a tell for a signed-in person who may direct the
 * crew on this app; nothing for anyone else, so a signed-out pill offers no
 * action. It is always on the forge's own origin.
 */
export function tellLink(
  db: Database,
  forgeUrl: string,
  app: AppRecord,
  viewerId: string | undefined,
): string | undefined {
  if (viewerId === undefined) return undefined;
  const viewer = getUserById(db, viewerId);
  const repo = getRepoById(db, app.repoId);
  if (viewer === undefined || !isActive(viewer) || repo === undefined) return undefined;
  if (!canRead(db, repo, viewer) || !mayDirectCrew(db, repo, viewer)) return undefined;
  return new URL(`/${repo.ownerName}/${repo.name}/tell`, forgeUrl).href;
}

/**
 * The forge's own "Make it yours" page for a public app, for a reader who is
 * not on its crew: signed out they meet the page's sign-in, which returns to
 * it. Nothing for a member of the repository, or when the app is not public.
 * The viewer comes from the app's own grant, never from the client's word.
 */
export function yoursLink(
  db: Database,
  forgeUrl: string,
  app: AppRecord,
  viewerId: string | undefined,
): string | undefined {
  if (app.access !== "public") return undefined;
  const repo = getRepoById(db, app.repoId);
  if (repo === undefined || repo.visibility !== "public") return undefined;
  if (viewerId !== undefined) {
    const viewer = getUserById(db, viewerId);
    if (viewer === undefined || !isActive(viewer)) return undefined;
    if (canWrite(db, repo, viewer)) return undefined;
  }
  return new URL(`/${repo.ownerName}/${repo.name}/make-it-yours`, forgeUrl).href;
}
