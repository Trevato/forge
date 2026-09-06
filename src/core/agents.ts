/**
 * Agents — the crew's rows. An agent is a user of kind `agent` (a flag on
 * the user row; see migration 14) with the little the runner needs to know
 * about it: which model, a brief in its own voice, and how much a run may
 * spend. Access to repositories is granted the way it is for a person
 * (collaborator, team) and lives where that lives. Pure data: no authz, no
 * events.
 */

import type { Database } from "bun:sqlite";
import { getUserById, type User } from "./users.ts";

export interface Agent {
  readonly user: User;
  /** A Claude Code model alias or id; empty means the runner's default. */
  readonly model: string;
  /** Appended to the system prompt of every run: who this agent is. */
  readonly brief: string;
  /** Spend per run in USD; 0 means the forge's default. */
  readonly budgetUsd: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

interface AgentRow {
  user_id: string;
  model: string;
  brief: string;
  budget_usd: number;
  created_by: string | null;
  created_at: string;
}

export const MODEL_MAX = 80;
export const BRIEF_MAX = 4_000;
export const BUDGET_MAX_USD = 100;

function toAgent(db: Database, row: AgentRow): Agent | undefined {
  const user = getUserById(db, row.user_id);
  if (!user) return undefined;
  return {
    user,
    model: row.model,
    brief: row.brief,
    budgetUsd: row.budget_usd,
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
    createdBy?: string | undefined;
  },
): Agent {
  db.query(
    "INSERT INTO agent (user_id, model, brief, budget_usd, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(
    input.userId,
    input.model ?? "",
    input.brief ?? "",
    input.budgetUsd ?? 0,
    input.createdBy ?? null,
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
    params.push(Math.min(Math.max(patch.budgetUsd, 0), BUDGET_MAX_USD));
    sets.push(`budget_usd = ?${params.length}`);
  }
  if (sets.length > 0) {
    params.push(userId);
    db.query(
      `UPDATE agent SET ${sets.join(", ")} WHERE user_id = ?${params.length}`,
    ).run(...params);
  }
  return getAgent(db, userId);
}

// ---- the crew of a repository ----

/** Put an agent on a repository's crew. Idempotent. */
export function addCrew(
  db: Database,
  repoId: string,
  userId: string,
  addedBy?: string,
): boolean {
  return (
    db
      .query(
        "INSERT OR IGNORE INTO repo_crew (repo_id, user_id, added_by) VALUES (?1, ?2, ?3)",
      )
      .run(repoId, userId, addedBy ?? null).changes > 0
  );
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
