/**
 * Seat an agent for a test: widens what it declares to include the seat, then
 * sets it on the repository. The product only ever narrows (#8907); a test
 * that wants a planner out of a plain agent says so here.
 */
import type { Database } from "bun:sqlite";
import { getAgent, parseRoles, setCrewRole, type CrewRole } from "../../src/core/agents.ts";

export function seatAs(db: Database, repoId: string, userId: string, role: CrewRole): boolean {
  const agent = getAgent(db, userId);
  if (agent && !agent.roles.includes(role))
    db.query("UPDATE agent SET roles = ?2 WHERE user_id = ?1").run(userId, parseRoles([...agent.roles, role].join(",")).join(","));
  return setCrewRole(db, repoId, userId, role);
}
