/**
 * Tell the crew: a sentence becomes an issue, the issue is routed to a
 * builder, and the builder is assigned, which is what starts a run. Every
 * door says it through this one action — the studio's box, the feed's
 * tells, a share to an agent, the MCP `tell` tool and the prompts that
 * turn a comment into a tell — so the rule of who may is asked once.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import type { Issue, TitleError } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { listRuns } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { routeIssue, type Routed } from "../crew/route.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireParticipant } from "./access.ts";
import { assignIssue, openIssue, type MirrorError } from "./issues.ts";
import { requireVerified } from "./verify.ts";

export interface Told {
  readonly issue: Issue;
  /** Who took it and how it was sized; absent when nobody is on the crew. */
  readonly routed: Routed | undefined;
  /** Whether the builder could be assigned (and so a run will start). */
  readonly assigned: boolean;
}

export type TellError =
  | "empty"
  | "not_found"
  | "unauthorized"
  /** Someone who may not direct the crew here (`crew/direct.ts`). */
  | "forbidden"
  /** Someone whose email is not verified yet (`verify.ts`). */
  | "unverified"
  | TitleError
  | "body_too_long"
  | MirrorError;

export async function tell(
  app: App,
  actor: User | undefined,
  repo: Repo,
  said: string,
): Promise<Result<Told, TellError>> {
  // A tell is a run: only someone who may direct the crew here says one,
  // and a refused tell opens nothing (`crew/direct.ts`).
  const participant = requireParticipant(app, actor, repo);
  if (!participant.ok) return participant;
  if (!mayDirectCrew(app.db, repo, participant.value)) return err("forbidden");
  // A tell sends the crew to work in this person's name: an address not yet
  // shown to be theirs tells nothing (`verify.ts`).
  if (!requireVerified(app, participant.value).ok) return err("unverified");
  const text = said.trim();
  if (text === "") return err("empty");
  const firstLine = text.split(/\n/)[0]!.trim();
  const title =
    firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77).trimEnd()}…`;
  const opened = openIssue(app, actor, repo, {
    title,
    body: text === firstLine ? "" : text,
  });
  if (!opened.ok) return opened;
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

/** What every door says when a tell is refused for an unverified address. */
export const UNVERIFIED_WORDS = "verify your email first";

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
