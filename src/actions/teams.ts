/**
 * Crew teams (`core/teams.ts`), for a forge admin who is a person. Everyone
 * else, an agent included, is told `not_found`.
 */

import type { App } from "../app.ts";
import { listAgents, type Agent } from "../core/agents.ts";
import { pullsWaitingOn, type QueuedPull } from "../core/team_queue.ts";
import { CHARTER_MAX, DIAL_MAX, getTeam, listTeams, parseDial, refusal, saveTeam, type Team, type TeamError } from "../core/teams.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "../settings/limits.ts";

/** One sentence for each refusal, said the same by the page, API, MCP tool and terminal. */
export const TEAM_SAYS: Record<TeamError, string> = {
  not_found: "No such team.",
  bad_dial: `A dial is a whole number from 0 to ${DIAL_MAX}.`,
  bad_charter: `A charter is at most ${CHARTER_MAX} characters.`,
  over_100: `The dials together may not pass ${DIAL_MAX}%.`,
  bad_member: "A member must be an agent on this forge.",
};

/** What a team is, in the words kept for a change: dial, member count, charter length. */
const summary = (t: Team): string =>
  `${t.dial}% · ${t.members.length} member${t.members.length === 1 ? "" : "s"} · charter ${t.charter.length}`;

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

export function readTeams(
  app: App,
  actor: User | undefined,
): Result<{ teams: Team[]; agents: Agent[] }, "not_found"> {
  const who = admin(actor);
  return who.ok ? ok({ teams: listTeams(app.db), agents: listAgents(app.db) }) : who;
}

/** The open pulls waiting on a team's review, as its viewer may read them: the page's list and the terminal's. */
export function readTeamQueue(
  app: App,
  actor: User | undefined,
  slug: string,
): Result<QueuedPull[], "not_found"> {
  const who = admin(actor);
  if (!who.ok) return who;
  return getTeam(app.db, slug) ? ok(pullsWaitingOn(app.db, slug, who.value)) : err("not_found");
}

/** What a change would make of a team, or why it is refused; nothing is written. */
export function planTeam(
  app: App,
  actor: User | undefined,
  slug: string,
  raw: { charter?: string; dial?: unknown; members?: string[] },
): Result<{ now: Team; input: { charter: string; dial: number; members: string[] } }, TeamError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const now = getTeam(app.db, slug);
  if (!now) return err("not_found");
  const dial = parseDial(raw.dial === undefined ? String(now.dial) : raw.dial);
  if (!dial.ok) return dial;
  const input = {
    charter: raw.charter ?? now.charter,
    dial: dial.value,
    members: [...new Set(raw.members ?? now.members)],
  };
  const refused = refusal(app.db, slug, input);
  return refused ? err(refused) : ok({ now, input });
}

/** A field left out keeps what the team has; the page always sends all three. */
export function changeTeam(
  app: App,
  actor: User | undefined,
  slug: string,
  raw: { charter?: string; dial?: unknown; members?: string[] },
): Result<Team, TeamError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const plan = planTeam(app, actor, slug, raw);
  if (!plan.ok) return plan;
  const { now, input } = plan.value;
  const saved = saveTeam(app.db, slug, input);
  if (!saved.ok) return saved;
  const next = saved.value;
  const same =
    next.charter === now.charter &&
    next.dial === now.dial &&
    next.members.join() === now.members.join();
  if (!same) {
    // Kept with who made it, as limits and quotas are; the audit reads the event.
    writeSetting(app.db, `team:${slug}`, null, summary(now), summary(next), who.value.id);
    app.bus.append({
      kind: "team.changed",
      actorId: who.value.id,
      payload: { slug, dial: next.dial, from: now.dial, members: next.members.length },
    });
  }
  return saved;
}

export interface TeamChange {
  readonly slug: string;
  readonly from: string;
  readonly to: string;
  readonly actorName: string;
  readonly at: string;
}

/** The most recent team changes, newest first. */
export function teamChanges(app: App, limit = 20): TeamChange[] {
  return app.db
    .query<{ key: string; from_value: string; to_value: string; username: string | null; at: string }, [number]>(
      `SELECT c.key, c.from_value, c.to_value, u.username, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        WHERE c.key LIKE 'team:%' ORDER BY c.at DESC, c.rowid DESC LIMIT ?1`,
    )
    .all(limit)
    .map((r) => ({ slug: r.key.slice(5), from: r.from_value, to: r.to_value, actorName: r.username ?? "", at: r.at }));
}
