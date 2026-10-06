/**
 * Organizations and teams. An org is a user row with kind "org" — it owns
 * repos through the same owner_id, so nothing about repos changes. Access to an
 * org's repos is granted through teams: a member's effective permission is the
 * highest permission across the teams they belong to. Every org has an "Owners"
 * team (admin); its members administer the org.
 */

import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getUserById, getUserByName, type User } from "./users.ts";

export type Permission = "read" | "write" | "admin";
export type Access = "none" | Permission;

const rank: Record<Access, number> = { none: 0, read: 1, write: 2, admin: 3 };

/** Does access `held` satisfy the requirement `needed`? */
export function accessAllows(held: Access, needed: Permission): boolean {
  return rank[held] >= rank[needed];
}

export interface Team {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly permission: Permission;
}

interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  permission: Permission;
}

export const OWNERS_TEAM = "Owners";

export type CreateOrgError = "invalid_name" | "name_taken";

/** Create an org and its Owners team, with `founderId` as the first owner. */
export function createOrg(
  db: Database,
  name: string,
  founderId: string,
): Result<User, CreateOrgError> {
  if (!isSafeName(name)) return err("invalid_name");
  // Users and orgs share one namespace, so any collision is a conflict.
  if (getUserByName(db, name)) return err("name_taken");

  const orgId = id();
  const create = db.transaction(() => {
    db.query(
      `INSERT INTO user (id, username, email, password_hash, kind)
       VALUES (?1, ?2, ?3, '!', 'org')`,
    ).run(orgId, name, `org-${orgId}@forge.invalid`);
    const teamId = id();
    db.query(
      "INSERT INTO team (id, org_id, name, permission) VALUES (?1, ?2, ?3, 'admin')",
    ).run(teamId, orgId, OWNERS_TEAM);
    db.query("INSERT INTO team_member (team_id, user_id) VALUES (?1, ?2)").run(
      teamId,
      founderId,
    );
  });
  create();
  return ok(getUserById(db, orgId)!);
}

/** The org by name, or undefined if the name is a plain user or absent. */
export function getOrg(db: Database, name: string): User | undefined {
  const user = getUserByName(db, name);
  return user?.kind === "org" ? user : undefined;
}

export function isOrg(user: User | undefined): boolean {
  return user?.kind === "org";
}

// ---- teams ----

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    permission: row.permission,
  };
}

export type CreateTeamError = "invalid_name" | "name_taken";

export function createTeam(
  db: Database,
  orgId: string,
  name: string,
  permission: Permission,
): Result<Team, CreateTeamError> {
  const clean = name.trim();
  if (clean === "" || clean.length > 60) return err("invalid_name");
  if (
    db
      .query(
        "SELECT 1 FROM team WHERE org_id = ?1 AND name = ?2 COLLATE NOCASE",
      )
      .get(orgId, clean)
  ) {
    return err("name_taken");
  }
  const teamId = id();
  db.query(
    "INSERT INTO team (id, org_id, name, permission) VALUES (?1, ?2, ?3, ?4)",
  ).run(teamId, orgId, clean, permission);
  return ok(
    toTeam(
      db
        .query<TeamRow, [string]>("SELECT * FROM team WHERE id = ?1")
        .get(teamId)!,
    ),
  );
}

export function listTeams(db: Database, orgId: string): Team[] {
  return db
    .query<
      TeamRow,
      [string]
    >("SELECT * FROM team WHERE org_id = ?1 ORDER BY name")
    .all(orgId)
    .map(toTeam);
}

export function getTeam(db: Database, teamId: string): Team | undefined {
  const row = db
    .query<TeamRow, [string]>("SELECT * FROM team WHERE id = ?1")
    .get(teamId);
  return row ? toTeam(row) : undefined;
}

/** Delete a team. The Owners team is protected — an org must keep its admins. */
export function deleteTeam(
  db: Database,
  orgId: string,
  teamId: string,
): boolean {
  const team = getTeam(db, teamId);
  if (!team || team.orgId !== orgId || team.name === OWNERS_TEAM) return false;
  return db.query("DELETE FROM team WHERE id = ?1").run(teamId).changes > 0;
}

export function addTeamMember(
  db: Database,
  team: Team,
  userId: string,
): boolean {
  const user = getUserById(db, userId);
  if (!user || user.kind === "org") return false; // can't nest orgs
  // An agent is never admin (CLAUDE.md, invariant 10): no team that confers
  // it takes one — the action says why (`agent_cannot_own`).
  if (user.kind === "agent" && team.permission === "admin") return false;
  return (
    db
      .query(
        "INSERT OR IGNORE INTO team_member (team_id, user_id) VALUES (?1, ?2)",
      )
      .run(team.id, userId).changes > 0
  );
}

/**
 * The people — never an agent — on an organization's Owners team: who keeps
 * it administrable. An organization must always have one.
 */
export function personOwners(db: Database, orgId: string): string[] {
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        `SELECT m.user_id FROM team_member m
           JOIN team t ON t.id = m.team_id
           JOIN user u ON u.id = m.user_id
          WHERE t.org_id = ?1 AND t.name = ?2 AND u.kind = 'user'
            AND u.is_agent = 0 AND u.removed_at IS NULL`,
      )
      .all(orgId, OWNERS_TEAM)
  ).map((r) => r.user_id);
}

/** The organizations `userId` is the only person owning: removing them would orphan these. */
export function soleOwnedOrgs(db: Database, userId: string): User[] {
  return (
    db
      .query<{ org_id: string }, [string, string]>(
        `SELECT DISTINCT t.org_id FROM team_member m JOIN team t ON t.id = m.team_id
          WHERE m.user_id = ?1 AND t.name = ?2`,
      )
      .all(userId, OWNERS_TEAM)
  )
    .filter((r) => {
      const left = personOwners(db, r.org_id);
      return left.length === 1 && left[0] === userId;
    })
    .map((r) => getUserById(db, r.org_id))
    .filter((u): u is User => u !== undefined);
}

/**
 * Remove a member, refusing to take the last person off the Owners team: an
 * organization needs someone who can administer it, and an agent never can.
 */
export function removeTeamMember(
  db: Database,
  team: Team,
  userId: string,
): boolean {
  if (team.name === OWNERS_TEAM) {
    // Taking an agent off is always allowed; taking off the last person is not.
    const people = personOwners(db, team.orgId);
    if (people.includes(userId) && people.length === 1) return false;
  }
  return (
    db
      .query("DELETE FROM team_member WHERE team_id = ?1 AND user_id = ?2")
      .run(team.id, userId).changes > 0
  );
}

/**
 * The teams of `orgId` that `user` may see: all of them for an org admin,
 * their own for a member, none for anyone else.
 */
export function listTeamsVisibleTo(
  db: Database,
  orgId: string,
  user: User | undefined,
): Team[] {
  if (!user) return [];
  if (accessAllows(orgAccess(db, orgId, user), "admin"))
    return listTeams(db, orgId);
  return db
    .query<TeamRow, [string, string]>(
      `SELECT team.* FROM team JOIN team_member ON team_member.team_id = team.id
       WHERE team.org_id = ?1 AND team_member.user_id = ?2 ORDER BY team.name`,
    )
    .all(orgId, user.id)
    .map(toTeam);
}

export function listTeamMembers(db: Database, teamId: string): User[] {
  const ids = db
    .query<
      { user_id: string },
      [string]
    >("SELECT user_id FROM team_member WHERE team_id = ?1")
    .all(teamId);
  return ids
    .map((r) => getUserById(db, r.user_id))
    .filter((u): u is User => u !== undefined);
}

// ---- permission resolution ----

/**
 * A user's effective access to an org's repos: the highest permission across
 * the teams of that org they belong to. Site admins get admin. This is the one
 * function repo permission checks consult for org-owned repos.
 */
export function orgAccess(
  db: Database,
  orgId: string,
  user: User | undefined,
): Access {
  if (!user) return "none";
  if (user.isAdmin) return "admin";
  const rows = db
    .query<{ permission: Permission }, [string, string]>(
      `SELECT team.permission FROM team
       JOIN team_member ON team_member.team_id = team.id
       WHERE team.org_id = ?1 AND team_member.user_id = ?2`,
    )
    .all(orgId, user.id);
  let best: Access = "none";
  for (const row of rows)
    if (rank[row.permission] > rank[best]) best = row.permission;
  return best;
}

/**
 * `orgAccess` for every org the user is on a team in, in one query: the
 * lists that must ask "may this viewer write here" of many org-owned repos
 * at once read this map instead of calling `orgAccess` per row. Site admins
 * are the caller's to short-circuit; an org missing from the map is "none".
 */
export function orgAccessByOrg(
  db: Database,
  user: User | undefined,
): Map<string, Access> {
  const out = new Map<string, Access>();
  if (!user) return out;
  const rows = db
    .query<{ org_id: string; permission: Permission }, [string]>(
      `SELECT team.org_id, team.permission FROM team
       JOIN team_member ON team_member.team_id = team.id
       WHERE team_member.user_id = ?1`,
    )
    .all(user.id);
  for (const row of rows)
    if (rank[row.permission] > rank[out.get(row.org_id) ?? "none"])
      out.set(row.org_id, row.permission);
  return out;
}

export function isOrgMember(
  db: Database,
  orgId: string,
  userId: string,
): boolean {
  return (
    (db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM team_member
         JOIN team ON team.id = team_member.team_id
         WHERE team.org_id = ?1 AND team_member.user_id = ?2`,
      )
      .get(orgId, userId)?.n ?? 0) > 0
  );
}

/** Orgs the user belongs to (via any team). */
export function listOrgsForUser(db: Database, userId: string): User[] {
  const ids = db
    .query<{ org_id: string }, [string]>(
      `SELECT DISTINCT team.org_id FROM team
       JOIN team_member ON team_member.team_id = team.id
       WHERE team_member.user_id = ?1`,
    )
    .all(userId);
  return ids
    .map((r) => getUserById(db, r.org_id))
    .filter((u): u is User => u !== undefined);
}
