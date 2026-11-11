/**
 * The crew a new forge comes with (#11154): a builder and a reviewer, seated
 * on every app the owner makes, with autonomy on, so the first ask is taken
 * with no setup. Written into a child's own database by the parent at spawn
 * (`seedStarterCrew`); the owner's organisation carries a mark, and a
 * repository made later under it is seated the same way (`seatStarterCrew`,
 * called by `createRepo`). A forge that already has crew is left as it is.
 */

import type { Database } from "bun:sqlite";
import { addCrew, createAgentRow, getAgentByName, listAgents, setCrewRole, type CrewRole } from "../core/agents.ts";
import { getRepoById, listReposOwnedBy, updateRepoSettings, type Repo } from "../core/repos.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import { createUser } from "../core/users.ts";
import { FORGE_CODE_NAME } from "./forge_code.ts";

const MARK = "starter_crew";

interface Seat {
  readonly name: string;
  readonly role: CrewRole;
  readonly brief: string;
}

export const STARTER_SEATS: readonly Seat[] = [
  {
    name: "builder",
    role: "builder",
    brief:
      "You build what the issue asks, in the smallest change that works. Read the repository first, keep its shape, add a test for every behaviour you add, and run the tests before you push.",
  },
  {
    name: "reviewer",
    role: "reviewer",
    brief:
      "You review pulls against the issue they answer. Check that behaviour is tested, that inputs are validated and outputs escaped, and that nothing beyond the ask slipped in. Say plainly what to change.",
  },
];

/** Whether this organisation was given the starter crew, so what it makes is seated on creation. */
export const hasStarterCrew = (db: Database, orgId: string): boolean => getUserSetting(db, orgId, MARK) === "on";

/**
 * Make the builder and reviewer when the forge has no crew at all, and mark
 * the organisation. Returns whether the crew exists afterwards.
 */
export async function seedStarterCrew(db: Database, orgId: string, founderId: string): Promise<boolean> {
  if (listAgents(db).length === 0) {
    for (const seat of STARTER_SEATS) {
      const made = await createUser(db, {
        username: seat.name,
        email: `${seat.name}@agents.spawn.forge.invalid`,
        agent: true,
        origin: "spawn",
      });
      if (!made.ok) return false;
      createAgentRow(db, { userId: made.value.id, brief: seat.brief, roles: [seat.role], createdBy: founderId });
    }
  }
  if (STARTER_SEATS.some((s) => getAgentByName(db, s.name) === undefined)) return false;
  setUserSetting(db, orgId, MARK, "on");
  for (const repo of listReposOwnedBy(db, orgId)) seatStarterCrew(db, repo, founderId);
  return true;
}

/** Seat the starter crew on one repository and turn autonomy on, unless a person already chose either. */
export function seatStarterCrew(db: Database, repo: Repo, founderId: string): void {
  // The forge's own code is not an app the owner made: it is seated by `adoptForgeCode`, autonomy as the owner sets it.
  if (!hasStarterCrew(db, repo.ownerId) || repo.name === FORGE_CODE_NAME) return;
  for (const seat of STARTER_SEATS) {
    const agent = getAgentByName(db, seat.name);
    if (agent === undefined) continue;
    addCrew(db, repo.id, agent.user.id, founderId, seat.role);
    setCrewRole(db, repo.id, agent.user.id, seat.role);
  }
  const fresh = getRepoById(db, repo.id) ?? repo;
  if (fresh.autonomy === "off" && fresh.autonomyBy === null)
    updateRepoSettings(db, fresh, { autonomy: "autonomous", autonomyBy: founderId });
}
