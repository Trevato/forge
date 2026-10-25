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
import { canRead, getRepoById } from "../core/repos.ts";
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
  const phase = <T>(name: string, work: () => T): T =>
    request === undefined ? work() : timePhase(request, name, work);
  if (viewerId === undefined) return undefined;
  const seen = phase("app", () => {
    const viewer = getUserById(db, viewerId);
    const repo = getRepoById(db, app.repoId);
    if (viewer === undefined || !isActive(viewer) || repo === undefined) return undefined;
    if (!canRead(db, repo, viewer)) return undefined;
    return { viewer, repo };
  });
  if (seen === undefined) return undefined;
  const { viewer, repo } = seen;
  const number = /^pull-(\d+)$/.exec(env)?.[1];
  if (number === undefined && env !== "production") return undefined;
  const pulled = phase("pull", () => {
    if (number === undefined) return { issueId: undefined };
    const pull = getIssue(db, repo.id, Number(number));
    if (pull === undefined || !mayView(db, repo, pull, viewer)) return undefined;
    return { issueId: pull.id as string | undefined };
  });
  if (pulled === undefined) return undefined;
  // A run on a sealed issue is not the viewer's to know of.
  const run = phase("working", () =>
    workingAgentRuns(db, repo.id, pulled.issueId).find((r) =>
      mayViewId(db, repo, r.issueId, viewer),
    ),
  );
  if (run === undefined) return undefined;
  const actor = run.actorId === null ? undefined : getUserById(db, run.actorId);
  return {
    who: actor?.username ?? "the crew",
    url: new URL(`/${repo.ownerName}/${repo.name}/runs/${run.id}`, forgeUrl).href,
  };
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
