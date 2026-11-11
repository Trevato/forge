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
  if (!(await makeStarterAgents(db, founderId))) return false;
  setUserSetting(db, orgId, MARK, "on");
  for (const repo of listReposOwnedBy(db, orgId)) seatStarterCrew(db, repo, founderId);
  return true;
}

/** Make one starter agent; false when its name could not be taken. */
async function makeSeat(db: Database, seat: Seat, founderId: string): Promise<boolean> {
  const made = await createUser(db, {
    username: seat.name,
    email: `${seat.name}@agents.spawn.forge.invalid`,
    agent: true,
    origin: "spawn",
  });
  if (!made.ok) return false;
  createAgentRow(db, { userId: made.value.id, brief: seat.brief, roles: [seat.role], createdBy: founderId });
  return true;
}

/** Make the builder and reviewer when the forge has no agent at all; true when both exist afterwards. */
async function makeStarterAgents(db: Database, founderId: string): Promise<boolean> {
  if (listAgents(db).length === 0) {
    for (const seat of STARTER_SEATS) if (!(await makeSeat(db, seat, founderId))) return false;
  }
  return STARTER_SEATS.every((s) => getAgentByName(db, s.name) !== undefined);
}

/** Seat one agent on a repository in one role; `setCrewRole` as well, because an existing seat is kept by `addCrew`. */
function seatAgent(db: Database, repo: Repo, userId: string, founderId: string, role: CrewRole): void {
  addCrew(db, repo.id, userId, founderId, role);
  setCrewRole(db, repo.id, userId, role);
}

/**
 * The first ask's app (#11508): a builder and a reviewer are seated on this
 * one app and autonomy is turned on as the founder, so the next tick starts
 * the ready issue. A forge with agents of its own keeps them (the first of
 * each role, two different agents); a role nobody holds is made as the starter
 * agent. Both seats or nothing: false (and autonomy untouched) when either
 * cannot be filled, so the caller says so. Other apps are left as they are.
 */
export async function seatFirstAskCrew(db: Database, repo: Repo, founderId: string): Promise<boolean> {
  if (listAgents(db).length === 0 && !(await makeStarterAgents(db, founderId))) return false;
  let builder = listAgents(db).find((a) => a.roles.includes("builder"));
  if (builder === undefined && (await makeSeat(db, STARTER_SEATS[0]!, founderId)))
    builder = getAgentByName(db, STARTER_SEATS[0]!.name);
  if (builder === undefined) return false;
  const other = (): ReturnType<typeof listAgents>[number] | undefined =>
    listAgents(db).find((a) => a.roles.includes("reviewer") && a.user.id !== builder!.user.id);
  let reviewer = other();
  if (reviewer === undefined && (await makeSeat(db, STARTER_SEATS[1]!, founderId))) reviewer = other();
  if (reviewer === undefined) return false;
  seatAgent(db, repo, builder.user.id, founderId, "builder");
  seatAgent(db, repo, reviewer.user.id, founderId, "reviewer");
  updateRepoSettings(db, getRepoById(db, repo.id) ?? repo, { autonomy: "autonomous", autonomyBy: founderId });
  return true;
}

/** Seat the starter crew on one repository and turn autonomy on, unless a person already chose either. */
export function seatStarterCrew(db: Database, repo: Repo, founderId: string): void {
  // The forge's own code is not an app the owner made: it is seated by `adoptForgeCode`, autonomy as the owner sets it.
  if (!hasStarterCrew(db, repo.ownerId) || repo.name === FORGE_CODE_NAME) return;
  for (const seat of STARTER_SEATS) {
    const agent = getAgentByName(db, seat.name);
    if (agent === undefined) continue;
    seatAgent(db, repo, agent.user.id, founderId, seat.role);
  }
  const fresh = getRepoById(db, repo.id) ?? repo;
  if (fresh.autonomy === "off" && fresh.autonomyBy === null)
    updateRepoSettings(db, fresh, { autonomy: "autonomous", autonomyBy: founderId });
}
