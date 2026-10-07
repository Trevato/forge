/**
 * The everyday account (#596): a forge's admin works day to day as an
 * ordinary account, kept apart from the one that can change everything.
 * The two are linked both ways in `user_setting`, so each account's page
 * can name the other; an admin who chose to keep working as admin has that
 * choice recorded, and is not asked again.
 *
 * The everyday account is an ordinary user, and the admin stays an admin.
 * One right is granted, on a spawned forge only: the everyday account
 * writes to the client's own org (`joinAsWriter`), or "day to day, use this
 * account" would hand its owner a forge whose apps it cannot see.
 */

import type { Database } from "bun:sqlite";
import { addTeamMember, createTeam, listTeams } from "./orgs.ts";
import { getUserSetting, setUserSetting } from "./settings.ts";
import { getUserById, type User } from "./users.ts";

const EVERYDAY = "everyday_account";
const ADMIN = "admin_account";
const CHOICE = "everyday_choice";

/** An admin's everyday account, when it has one. */
export function everydayOf(db: Database, admin: User): User | undefined {
  const id = getUserSetting(db, admin.id, EVERYDAY);
  return id === undefined ? undefined : getUserById(db, id);
}

/** The admin account an everyday account belongs to, when it is one. */
export function adminOf(db: Database, user: User): User | undefined {
  const id = getUserSetting(db, user.id, ADMIN);
  return id === undefined ? undefined : getUserById(db, id);
}

/** Link an admin and its everyday account, both ways. */
export function linkEveryday(db: Database, admin: User, everyday: User): void {
  setUserSetting(db, admin.id, EVERYDAY, everyday.id);
  setUserSetting(db, everyday.id, ADMIN, admin.id);
}

/** The org's writers, made the first time someone joins it this way. */
export const WRITERS_TEAM = "Writers";
/** The name used when the org already has a "Writers" team that grants something else. */
const EVERYDAY_WRITERS = "Everyday writers";

/**
 * Add the everyday account to an org as a writer: never an owner of it.
 * A team of that name that grants something else is left as it is (never
 * widened); the account joins a team of its own instead. False only when
 * no write team could be found or made, so the caller can say so.
 */
export function joinAsWriter(db: Database, org: User, everyday: User): boolean {
  const teams = listTeams(db, org.id);
  for (const name of [WRITERS_TEAM, EVERYDAY_WRITERS]) {
    let team = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (team && team.permission !== "write") continue;
    if (!team) {
      const made = createTeam(db, org.id, name, "write");
      if (!made.ok) continue;
      team = made.value;
    }
    addTeamMember(db, team, everyday.id);
    return true;
  }
  return false;
}

/** The admin chose to keep working as admin: recorded, and not asked again. */
export function keepAdmin(db: Database, admin: User): void {
  setUserSetting(db, admin.id, CHOICE, "admin");
}

/** Whether the admin chose to keep working as admin. */
export const keptAdmin = (db: Database, admin: User): boolean =>
  getUserSetting(db, admin.id, CHOICE) === "admin";

/** Whether the forge should ask this person to make an everyday account. */
export function askForEveryday(db: Database, user: User | undefined): boolean {
  return (
    user !== undefined &&
    user.isAdmin &&
    user.kind === "user" &&
    everydayOf(db, user) === undefined &&
    adminOf(db, user) === undefined &&
    !keptAdmin(db, user)
  );
}

/** The two sentences of why, said the same way everywhere. */
export const EVERYDAY_WHY =
  "Admin can change everything here, including who can see what. Use it when you mean to; day to day, use an account that cannot break the forge.";
