/**
 * Roles: an account is a guest, a member or an admin. Admin is the `is_admin`
 * flag, a member is a row in `member`, everyone else is a guest. `CAN` is the
 * one table of what each role may do; `docs/ROLES.md` repeats it and a test
 * fails when they differ. Part 1 records and shows roles — nothing is
 * refused because of one yet. Pure data; who may promote is the action's.
 */

import type { Database } from "bun:sqlite";

export const ROLES = ["guest", "member", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ABILITIES = {
  read: "Read what is public",
  comment: "Comment and open issues",
  make_it_yours: "Make an app their own",
  run_crew: "Run a crew on a model allowance",
  administer: "Administer the forge",
} as const;
export type Ability = keyof typeof ABILITIES;

/** What each role can do. */
export const CAN: Readonly<Record<Role, readonly Ability[]>> = {
  guest: ["read", "comment"],
  member: ["read", "comment", "make_it_yours", "run_crew"],
  admin: ["read", "comment", "make_it_yours", "run_crew", "administer"],
};

export const can = (role: Role, ability: Ability): boolean => CAN[role].includes(ability);

/** One role's row of the table: every ability, yes or no. */
export function rowOf(role: Role): Record<Ability, boolean> {
  const row = {} as Record<Ability, boolean>;
  for (const a of Object.keys(ABILITIES) as Ability[]) row[a] = can(role, a);
  return row;
}

/** The table as `docs/ROLES.md` prints it. */
export function rolesTable(): string {
  const rows = (Object.keys(ABILITIES) as Ability[]).map(
    (a) => `| ${ABILITIES[a]} | ${ROLES.map((r) => (can(r, a) ? "yes" : "no")).join(" | ")} |`,
  );
  return [`| Ability | ${ROLES.join(" | ")} |`, `| --- | ${ROLES.map(() => "---").join(" | ")} |`, ...rows].join("\n");
}

export function roleOf(db: Database, user: { id: string; isAdmin: boolean }): Role {
  if (user.isAdmin) return "admin";
  const row = db.query<{ n: number }, [string]>("SELECT 1 AS n FROM member WHERE user_id = ?1").get(user.id);
  return row ? "member" : "guest";
}

/** Make an account a member (true) or a guest again (false). */
export function setMember(db: Database, userId: string, member: boolean, by: string, now: Date): void {
  if (!member) {
    db.query("DELETE FROM member WHERE user_id = ?1").run(userId);
    return;
  }
  db.query("INSERT OR IGNORE INTO member (user_id, promoted_by, promoted_at) VALUES (?1, ?2, ?3)").run(
    userId,
    by,
    now.toISOString(),
  );
}

export interface Person {
  readonly username: string;
  readonly role: Role;
  readonly usdPerMonth: number | null;
}

/** Every person (not an agent, not an organization) with role and model grant, newest first, in one query. */
export function listPeople(db: Database): Person[] {
  return db
    .query<{ username: string; is_admin: number; member: number | null; usd: number | null }, []>(
      `SELECT u.username, u.is_admin, m.user_id AS member, g.usd_per_month AS usd
       FROM user u
       LEFT JOIN member m ON m.user_id = u.id
       LEFT JOIN model_grant g ON g.user_id = u.id
       WHERE u.kind = 'user' AND u.is_agent = 0 AND u.removed_at IS NULL
       ORDER BY u.created_at DESC, u.username`,
    )
    .all()
    .map((r) => ({
      username: r.username,
      role: r.is_admin === 1 ? "admin" : r.member !== null ? "member" : "guest",
      usdPerMonth: r.usd,
    }));
}
