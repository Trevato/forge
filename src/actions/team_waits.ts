/**
 * A pull that starts waiting on a named team's review says so once on the
 * outbox (#10164): `pull.team_waiting`, which only that team's members are
 * told (`event_audience.ts`, the "team" audience). While it stays held
 * nothing more is said; when the team's approval ends the wait,
 * `pull.team_answered` closes it, so a later hold is news again.
 * `teamsHolding` decides; this only compares with what was last said.
 */

import type { App } from "../app.ts";
import { teamsHolding } from "../core/issue_teams.ts";
import { closesFromBody, getPull, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";

/** Open pulls read when an issue's teams change: enough for any real fan-in, bounded either way. */
const CLOSERS_MAX = 50;

/**
 * Whether each team's newest word on this pull was that it waits. One read:
 * `+repo_id` keeps the planner on the kind index, so it walks only the
 * team-wait events, never the repository's whole outbox.
 */
function waitingNow(app: App, repoId: string, number: number): Map<string, boolean> {
  const rows = app.db
    .query<{ kind: string; team: string }, [string, number]>(
      `SELECT kind, json_extract(payload, '$.team') AS team FROM event
       WHERE kind IN ('pull.team_waiting', 'pull.team_answered') AND +repo_id = ?1
         AND json_extract(payload, '$.number') = ?2
       ORDER BY seq`,
    )
    .all(repoId, number);
  const out = new Map<string, boolean>();
  for (const r of rows) out.set(r.team, r.kind === "pull.team_waiting");
  return out;
}

/** Say which named teams newly hold the pull, and which have stopped. */
export function announceTeamWaits(app: App, repo: Repo, pull: Pull, actorId: string | undefined): void {
  const holding = teamsHolding(app.db, pull);
  const said = waitingNow(app, repo.id, pull.number);
  for (const v of holding) {
    if (said.get(v.team) === true) continue;
    app.bus.append({
      kind: "pull.team_waiting",
      repoId: repo.id,
      actorId,
      payload: { number: pull.number, team: v.team, name: v.name },
    });
  }
  const held = new Set(holding.map((v) => v.team));
  for (const [team, waiting] of said) {
    if (!waiting || held.has(team)) continue;
    app.bus.append({
      kind: "pull.team_answered",
      repoId: repo.id,
      actorId,
      payload: { number: pull.number, team },
    });
  }
}

/** Naming teams on an issue can newly hold the open pulls that close it. */
export function announceIssueTeamWaits(app: App, repo: Repo, issueNumber: number, actorId: string | undefined): void {
  // Only pulls whose body mentions `#N` at all; `closesFromBody` decides which close it.
  const open = app.db
    .query<{ number: number }, [string, string]>(
      `SELECT number FROM issue
       WHERE repo_id = ?1 AND kind = 'pull' AND state = 'open' AND instr(body, ?2) > 0
       ORDER BY number DESC LIMIT ${CLOSERS_MAX}`,
    )
    .all(repo.id, `#${issueNumber}`);
  for (const { number } of open) {
    const pull = getPull(app.db, repo.id, number);
    if (pull !== undefined && closesFromBody(pull.body).includes(issueNumber)) announceTeamWaits(app, repo, pull, actorId);
  }
}
