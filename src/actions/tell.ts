/**
 * Tell the crew: a sentence becomes an issue, the issue is routed to a
 * builder, and the builder is assigned, which is what starts a run. The
 * studio's box and the forge's MCP `tell` tool are the same act, so it
 * lives here once.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import type { Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { listRuns } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { routeIssue, type Routed } from "../crew/route.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { assignIssue, openIssue } from "./issues.ts";

export interface Told {
  readonly issue: Issue;
  /** Who took it and how it was sized; absent when nobody is on the crew. */
  readonly routed: Routed | undefined;
  /** Whether the builder could be assigned (and so a run will start). */
  readonly assigned: boolean;
}

export type TellError = "empty" | "refused";

export async function tell(
  app: App,
  actor: User | undefined,
  repo: Repo,
  said: string,
): Promise<Result<Told, TellError>> {
  const text = said.trim();
  if (text === "") return err("empty");
  // A tell is a run: only someone who may direct the crew here says one,
  // and a refused tell opens nothing (`crew/direct.ts`).
  if (!mayDirectCrew(app.db, repo, actor)) return err("refused");
  const firstLine = text.split(/\n/)[0]!.trim();
  const title =
    firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}…`;
  const opened = openIssue(app, actor, repo, {
    title,
    body: text === firstLine ? "" : text,
  });
  if (!opened.ok) return err("refused");
  const crew = listCrewRoles(app.db, repo.id);
  const inFlight = new Map<string, number>();
  for (const r of listRuns(app.db, repo.id, { kind: "agent", limit: 50 }))
    if ((r.state === "running" || r.state === "queued") && r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const routed = await routeIssue(app, repo, opened.value, crew, inFlight);
  if (routed === undefined)
    return ok({ issue: opened.value, routed: undefined, assigned: false });
  const assigned = assignIssue(
    app,
    actor,
    repo,
    opened.value,
    routed.builder.user,
  );
  return ok({ issue: opened.value, routed, assigned: assigned.ok });
}

/** What happened, in the sentence both doors say. */
export function toldWords(told: Told): string {
  if (told.routed === undefined)
    return `Told as #${told.issue.number}. Nobody is on the crew to take it yet — add someone under Settings → Crew.`;
  const r = told.routed;
  const who = r.builder.user.username;
  return told.assigned
    ? `${who} is on it — ${r.size} ${r.kind}${r.by === "rule" ? "" : `, ${r.by} decided in ${r.ms} ms`}.`
    : `Told as #${told.issue.number}, but ${who} could not take it.`;
}
