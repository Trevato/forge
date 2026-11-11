/**
 * Agents — the crew's rows. An agent is a user of kind `agent` (a flag on
 * the user row; see migration 14) with the little the runner needs to know
 * about it: which model, a brief in its own voice, and how much a run may
 * spend. Access to repositories is granted the way it is for a person
 * (collaborator, team) and lives where that lives. Pure data: no authz, no
 * events.
 */

import type { Database } from "bun:sqlite";
import { limitValue } from "../settings/limits.ts";
import { getUserById, getUsersByIds, type User } from "./users.ts";

export interface Agent {
  readonly user: User;
  /** A Claude Code model alias or id; empty means the runner's default. */
  readonly model: string;
  /** Appended to the system prompt of every run: who this agent is. */
  readonly brief: string;
  /** Spend per run in USD; 0 means the forge's default. */
  readonly budgetUsd: number;
  /** The seats it can hold, in planner, builder, reviewer order; never empty. */
  readonly roles: readonly CrewRole[];
  readonly createdBy: string | null;
  readonly createdAt: string;
}

interface AgentRow {
  user_id: string;
  model: string;
  brief: string;
  budget_usd: number;
  roles: string;
  created_by: string | null;
  created_at: string;
}

export const MODEL_MAX = 80;
export const BRIEF_MAX = 4_000;

function toAgent(db: Database, row: AgentRow): Agent | undefined {
  const user = getUserById(db, row.user_id);
  return user ? agentOf(user, row) : undefined;
}

function agentOf(user: User, row: AgentRow): Agent {
  return {
    user,
    model: row.model,
    brief: row.brief,
    budgetUsd: row.budget_usd,
    roles: parseRoles(row.roles),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createAgentRow(
  db: Database,
  input: {
    userId: string;
    model?: string | undefined;
    brief?: string | undefined;
    budgetUsd?: number | undefined;
    roles?: readonly CrewRole[] | undefined;
    createdBy?: string | undefined;
  },
): Agent {
  db.query(
    "INSERT INTO agent (user_id, model, brief, budget_usd, created_by, roles) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(
    input.userId,
    input.model ?? "",
    input.brief ?? "",
    input.budgetUsd ?? 0,
    input.createdBy ?? null,
    joinRoles(input.roles),
  );
  return getAgent(db, input.userId)!;
}

export function getAgent(db: Database, userId: string): Agent | undefined {
  const row = db
    .query<AgentRow, [string]>("SELECT * FROM agent WHERE user_id = ?1")
    .get(userId);
  return row ? toAgent(db, row) : undefined;
}

export function getAgentByName(
  db: Database,
  username: string,
): Agent | undefined {
  const row = db
    .query<
      AgentRow,
      [string]
    >("SELECT agent.* FROM agent JOIN user ON user.id = agent.user_id WHERE user.username = ?1 COLLATE NOCASE")
    .get(username);
  return row ? toAgent(db, row) : undefined;
}

/** Every agent on the forge, by name. */
export function listAgents(db: Database): Agent[] {
  const rows = db
    .query<
      AgentRow,
      []
    >("SELECT agent.* FROM agent JOIN user ON user.id = agent.user_id ORDER BY user.username COLLATE NOCASE")
    .all();
  const out: Agent[] = [];
  for (const row of rows) {
    const agent = toAgent(db, row);
    if (agent) out.push(agent);
  }
  return out;
}

export interface AgentPatch {
  model?: string;
  brief?: string;
  budgetUsd?: number;
  /** Replaces the agent's roles; empty or unknown ones are ignored. */
  roles?: readonly CrewRole[];
}

export function updateAgent(
  db: Database,
  userId: string,
  patch: AgentPatch,
): Agent | undefined {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (patch.model !== undefined) {
    params.push(patch.model.slice(0, MODEL_MAX));
    sets.push(`model = ?${params.length}`);
  }
  if (patch.brief !== undefined) {
    params.push(patch.brief.slice(0, BRIEF_MAX));
    sets.push(`brief = ?${params.length}`);
  }
  if (patch.budgetUsd !== undefined) {
    params.push(Math.min(Math.max(patch.budgetUsd, 0), limitValue(db, "agent.budget_max_usd")));
    sets.push(`budget_usd = ?${params.length}`);
  }
  if (patch.roles !== undefined && patch.roles.length > 0) {
    params.push(joinRoles(patch.roles));
    sets.push(`roles = ?${params.length}`);
  }
  if (sets.length > 0) {
    params.push(userId);
    db.query(
      `UPDATE agent SET ${sets.join(", ")} WHERE user_id = ?${params.length}`,
    ).run(...params);
  }
  const agent = getAgent(db, userId);
  // A seat the agent no longer declares moves to one it does: a repo narrows, never widens.
  if (agent && patch.roles !== undefined)
    db.query(
      "UPDATE repo_crew SET role = ?2 WHERE user_id = ?1 AND instr(',' || ?3 || ',', ',' || role || ',') = 0",
    ).run(userId, agent.roles[0]!, agent.roles.join(","));
  return agent;
}

// ---- the crew of a repository ----

/**
 * Put an agent on a repository's crew. Idempotent. Only an agent: the
 * database refuses anyone else (`repo_crew_agents_only`), so a caller that passes a
 * person has a bug, and hears about it as an error, not a quiet no.
 */
export function addCrew(
  db: Database,
  repoId: string,
  userId: string,
  addedBy?: string,
  role?: CrewRole,
): boolean {
  const agent = getAgent(db, userId);
  const declared = agent?.roles ?? [];
  // No default to builder: the seat is the one asked for, else the first the agent declares.
  // A user with no agent row goes on to the insert, where the database refuses a person.
  const seat = agent
    ? role !== undefined && declared.includes(role) ? role : declared[0]
    : (role ?? "builder");
  if (seat === undefined) return false;
  return (
    db
      .query(
        "INSERT OR IGNORE INTO repo_crew (repo_id, user_id, added_by, role) VALUES (?1, ?2, ?3, ?4)",
      )
      .run(repoId, userId, addedBy ?? null, seat).changes > 0
  );
}

/**
 * People — not agents — on any crew: what `repo_crew_agents_only` now refuses, if any
 * was put there before it. Reported at boot, never removed by the forge.
 */
export function peopleOnCrews(
  db: Database,
): { repoId: string; username: string }[] {
  return db
    .query<{ repoId: string; username: string }, []>(
      `SELECT repo_crew.repo_id AS repoId, user.username AS username
       FROM repo_crew JOIN user ON user.id = repo_crew.user_id
       WHERE user.is_agent = 0 ORDER BY repo_crew.repo_id, user.username`,
    )
    .all();
}

export function removeCrew(
  db: Database,
  repoId: string,
  userId: string,
): boolean {
  return (
    db
      .query("DELETE FROM repo_crew WHERE repo_id = ?1 AND user_id = ?2")
      .run(repoId, userId).changes > 0
  );
}

export function isCrew(db: Database, repoId: string, userId: string): boolean {
  return (
    db
      .query<
        { n: number },
        [string, string]
      >("SELECT 1 AS n FROM repo_crew WHERE repo_id = ?1 AND user_id = ?2")
      .get(repoId, userId) !== null
  );
}

/** The agents on a repository, by name. */
export function listCrew(db: Database, repoId: string): Agent[] {
  const rows = db
    .query<AgentRow, [string]>(
      `SELECT agent.* FROM repo_crew
       JOIN agent ON agent.user_id = repo_crew.user_id
       JOIN user ON user.id = agent.user_id
       WHERE repo_crew.repo_id = ?1 ORDER BY user.username COLLATE NOCASE`,
    )
    .all(repoId);
  const out: Agent[] = [];
  for (const row of rows) {
    const agent = toAgent(db, row);
    if (agent) out.push(agent);
  }
  return out;
}

/** The crews of many repositories at once, keyed by repo id — one query per chunk. */
export function crewForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ repo_id: string; username: string }, string[]>(
        `SELECT repo_crew.repo_id, user.username FROM repo_crew
         JOIN user ON user.id = repo_crew.user_id
         WHERE repo_crew.repo_id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY user.username COLLATE NOCASE`,
      )
      .all(...batch);
    for (const row of rows) {
      const names = out.get(row.repo_id);
      if (names) names.push(row.username);
      else out.set(row.repo_id, [row.username]);
    }
  }
  return out;
}

/**
 * Retire an agent. Its tokens and its agent row go, so nothing can act as
 * it again and it leaves the crew. The user row goes too when nothing
 * references it; an agent that authored a pull or a comment keeps its
 * account as history — `author_id` has no cascade, and history is history.
 * Such a row still reads as kind `agent`, with no brief and no way in.
 */
export function deleteAgent(db: Database, userId: string): boolean {
  const removed = db
    .query("DELETE FROM agent WHERE user_id = ?1")
    .run(userId).changes;
  if (removed === 0) return false;
  db.query("DELETE FROM token WHERE user_id = ?1").run(userId);
  try {
    db.query("DELETE FROM user WHERE id = ?1 AND is_agent = 1").run(userId);
  } catch (error) {
    if (!(error instanceof Error && /FOREIGN KEY/.test(error.message)))
      throw error;
  }
  return true;
}

// ---- roles on a crew ----

/**
 * What a crew member is for on one repository: a builder takes what is
 * ready, a planner turns a direction into a map, a reviewer looks at what
 * landed. Per repository, because the same agent may plan one and build
 * another.
 */
export type CrewRole = "builder" | "planner" | "reviewer" | "maintainer";
export const CREW_ROLES: readonly CrewRole[] = [
  "planner",
  "builder",
  "reviewer",
  "maintainer",
];
export const isCrewRole = (value: unknown): value is CrewRole =>
  (CREW_ROLES as readonly unknown[]).includes(value);

export function crewRole(
  db: Database,
  repoId: string,
  userId: string,
): CrewRole | undefined {
  const row = db
    .query<
      { role: string; roles: string },
      [string, string]
    >("SELECT repo_crew.role, agent.roles FROM repo_crew JOIN agent ON agent.user_id = repo_crew.user_id WHERE repo_id = ?1 AND repo_crew.user_id = ?2")
    .get(repoId, userId);
  return row ? seatOf(row.role, parseRoles(row.roles)) : undefined;
}

/** The roles an agent declares, in seat order; a bad or empty value reads as builder. */
export function parseRoles(value: string): CrewRole[] {
  const out = CREW_ROLES.filter((r) => value.split(",").includes(r));
  return out.length > 0 ? out : ["builder"];
}

function joinRoles(roles: readonly CrewRole[] | undefined): string {
  return parseRoles((roles ?? []).join(",")).join(",");
}

/** The seat a repo row holds: its own when the agent declares it, else the agent's first. */
function seatOf(role: string, declared: readonly CrewRole[]): CrewRole {
  return isCrewRole(role) && declared.includes(role) ? role : declared[0]!;
}

/** The repositories where an agent holds a seat that `roles` would not declare. */
export function seatsOutside(db: Database, userId: string, roles: readonly CrewRole[]): string[] {
  return db
    .query<{ name: string }, [string, string]>(
      `SELECT repo.name FROM repo_crew JOIN repo ON repo.id = repo_crew.repo_id
       WHERE repo_crew.user_id = ?1 AND instr(',' || ?2 || ',', ',' || repo_crew.role || ',') = 0`,
    )
    .all(userId, roles.join(","))
    .map((r) => r.name);
}

export function setCrewRole(
  db: Database,
  repoId: string,
  userId: string,
  role: CrewRole,
): boolean {
  // A repository narrows what an agent declares and never widens it.
  if (!getAgent(db, userId)?.roles.includes(role)) return false;
  return (
    db
      .query(
        "UPDATE repo_crew SET role = ?3 WHERE repo_id = ?1 AND user_id = ?2",
      )
      .run(repoId, userId, role).changes > 0
  );
}

/** The crew with each member's role, by name: `crewSeats` for one repository. */
export function listCrewRoles(
  db: Database,
  repoId: string,
): { agent: Agent; role: CrewRole }[] {
  return (crewSeats(db, [repoId]).get(repoId) ?? []).map(({ agent, role }) => ({ agent, role }));
}

/** One seat on a repository's crew. */
export interface CrewSeat {
  readonly agent: Agent;
  readonly role: CrewRole;
  /**
   * Whether the seat is held as written: a team role, or a roster row
   * whose role the agent still declares.
   */
  readonly held: boolean;
}

/** A role on an org team (#571): a crew seat, or `member`, the team's access and no seat. */
export type TeamRole = CrewRole | "member";
export const TEAM_ROLES: readonly TeamRole[] = [...CREW_ROLES, "member"];
export const isTeamRole = (value: unknown): value is TeamRole =>
  (TEAM_ROLES as readonly unknown[]).includes(value);

/**
 * The crew of each repository, by repo, by name — the one function the
 * routing reads for planner, builder and reviewer (#571). An org-owned
 * repository's crew is the agents the org's write and admin teams give a
 * role, each in that seat (a role the agent does not declare sits in its
 * first declared one; on many teams an agent takes its first by team
 * name). A `member` holds no seat: it is the team's access, nothing more,
 * so a membership from before roles changes no crew. When no such team
 * seats an agent, the repository's own roster (`repo_crew`) is its crew,
 * unchanged.
 */
export function crewSeats(
  db: Database,
  repoIds: readonly string[],
): Map<string, CrewSeat[]> {
  const unique = [...new Set(repoIds)];
  type SeatRow = AgentRow & { repo_id: string; seat: string; source: "team" | "roster" };
  const rows: SeatRow[] = [];
  const CHUNK = 400;
  // One read per chunk: the team seats and the roster together, told apart by `source`.
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const marks = batch.map((_, n) => `?${n + 1}`).join(",");
    rows.push(
      ...db
        .query<SeatRow, string[]>(
          `SELECT * FROM (
             SELECT 'team' AS source, repo.id AS repo_id, team_member.role AS seat,
                    team.name AS via, user.username AS uname, agent.*
             FROM repo
             JOIN team ON team.org_id = repo.owner_id AND team.permission IN ('write','admin')
             JOIN team_member ON team_member.team_id = team.id AND team_member.role <> 'member'
             JOIN agent ON agent.user_id = team_member.user_id
             JOIN user ON user.id = agent.user_id
             WHERE repo.id IN (${marks})
             UNION ALL
             SELECT 'roster' AS source, repo_crew.repo_id, repo_crew.role AS seat,
                    '' AS via, user.username AS uname, agent.*
             FROM repo_crew
             JOIN agent ON agent.user_id = repo_crew.user_id
             JOIN user ON user.id = agent.user_id
             WHERE repo_crew.repo_id IN (${marks})
           ) ORDER BY uname COLLATE NOCASE, via COLLATE NOCASE`,
        )
        .all(...batch),
    );
  }
  const teamed = new Set(rows.filter((r) => r.source === "team").map((r) => r.repo_id));
  const teamRows = rows.filter((r) => r.source === "team");
  const rosterRows = rows.filter((r) => r.source === "roster" && !teamed.has(r.repo_id));
  const users = getUsersByIds(db, [...teamRows, ...rosterRows].map((r) => r.user_id));
  const out = new Map<string, CrewSeat[]>();
  const put = (repoId: string, seat: CrewSeat) => {
    const list = out.get(repoId);
    if (list) list.push(seat);
    else out.set(repoId, [seat]);
  };
  // Team rows: one seat per agent per repository, the first by team name.
  const chosen = new Map<string, AgentRow & { repo_id: string; seat: string }>();
  for (const row of teamRows) {
    const key = `${row.repo_id}\u0000${row.user_id}`;
    if (!chosen.has(key)) chosen.set(key, row);
  }
  for (const row of chosen.values()) {
    const user = users.get(row.user_id);
    if (!user) continue;
    const agent = agentOf(user, row);
    put(row.repo_id, { agent, role: seatOf(row.seat, agent.roles), held: true });
  }
  for (const row of rosterRows) {
    const user = users.get(row.user_id);
    if (!user) continue;
    const agent = agentOf(user, row);
    put(row.repo_id, {
      agent,
      role: seatOf(row.seat, agent.roles),
      held: isCrewRole(row.seat) && agent.roles.includes(row.seat),
    });
  }
  return out;
}

/**
 * The crew members holding `role` on each of these repositories, by repo,
 * in name order — `crewSeats`, keeping the seats held as written.
 */
export function crewWithRole(
  db: Database,
  repoIds: readonly string[],
  role: CrewRole,
): Map<string, Agent[]> {
  const out = new Map<string, Agent[]>();
  for (const [repoId, seats] of crewSeats(db, repoIds)) {
    const agents = seats.filter((s) => s.held && s.role === role).map((s) => s.agent);
    if (agents.length > 0) out.set(repoId, agents);
  }
  return out;
}

/**
 * Which of these repositories have a builder on their crew, as a set — a
 * repo absent from it has none, and nothing can pick up a tell there
 * (`routeIssue`, crew/route.ts). The shelf's one batched read for that
 * question, so it never asks it once per row.
 */
export function reposWithBuilder(
  db: Database,
  repoIds: readonly string[],
): Set<string> {
  return new Set(crewWithRole(db, repoIds, "builder").keys());
}
