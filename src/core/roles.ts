/**
 * Roles: an account is a guest, a member or an admin. Admin is the `is_admin`
 * flag, a member is a row in `member`, everyone else is a guest. `CAN` is the
 * one table of what each role may do; `docs/ROLES.md` repeats it and a test
 * fails when they differ. A guest is refused what the table withholds:
 * owning a repository beyond a contribution fork (`core/contribute.ts`), making
 * an app one's own, starting a run (`requireAbility` in `actions/roles.ts`).
 * Pure data; who may promote is the action's.
 */

import type { Database } from "bun:sqlite";

export const ROLES = ["guest", "member", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const ABILITIES = {
  read: "Read what is public",
  comment: "Comment and open issues",
  contribute: "Help build a public repository by forking it and sending a pull for review",
  make_it_yours: "Create a repository or copy an app",
  run_crew: "Run a crew on a model allowance",
  administer: "Administer the forge",
} as const;
export type Ability = keyof typeof ABILITIES;

/** What each role can do. */
export const CAN: Readonly<Record<Role, readonly Ability[]>> = {
  guest: ["read", "comment", "contribute"],
  member: ["read", "comment", "contribute", "make_it_yours", "run_crew"],
  admin: ["read", "comment", "contribute", "make_it_yours", "run_crew", "administer"],
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

/** The words a guest is refused with, on every surface: what they cannot do, and what they can. */
export const NOT_A_MEMBER =
  "this account is a guest. A guest can read, comment and help build public apps by sending changes for review. To run your own apps and crew, get your own forge at /forges/new, or with the MCP tool spawn";

/** The words a member (or guest) is refused admin settings and releases with. */
export const NOT_AN_ADMIN = "only an admin can change the forge's settings or its releases";

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What a role means, in two sentences built from `CAN` and the refusal
 * words, so the page that explains roles says what the guards enforce:
 * what a guest is refused, and what only an admin may do. `guestLacks` and
 * `adminOnly` name the rows each sentence stands for.
 */
export const guestLacks = (): Ability[] =>
  (Object.keys(ABILITIES) as Ability[]).filter((a) => !can("guest", a) && can("member", a));
export const adminOnly = (): Ability[] =>
  (Object.keys(ABILITIES) as Ability[]).filter((a) => can("admin", a) && !can("member", a));

export function roleLimits(): string {
  const withheld = guestLacks().map((a) => lower(ABILITIES[a]));
  // A label may hold its own "or", so the last item is set off with ", or".
  const list = withheld.length < 2 ? withheld.join("") : `${withheld.slice(0, -1).join(", ")}, or ${withheld.at(-1)}`;
  return `A guest cannot ${list}. ${capital(NOT_AN_ADMIN)}.`;
}

/**
 * Whether the table withholds `ability` from this account. Only a person
 * can be a guest: agents and organizations are not accounts the owner
 * promotes, and other rules govern them. Nothing switches it off.
 */
export function lacks(
  db: Database,
  user: { id: string; isAdmin: boolean; kind: string },
  ability: Ability,
): boolean {
  if (user.kind !== "user") return false;
  return !can(roleOf(db, user), ability);
}

/**
 * `lacks(…, "run_crew")` as SQL, for a query that must not spend a row on
 * a guest: true when `userId` (a column or subquery, never input) names a
 * person who is neither an admin nor a member. Kept beside `roleOf` so the
 * two say the same thing.
 */
export const guestSql = (userId: string): string =>
  `EXISTS (SELECT 1 FROM user g WHERE g.id = ${userId}
     AND g.kind = 'user' AND g.is_agent = 0 AND g.is_admin = 0
     AND NOT EXISTS (SELECT 1 FROM member m WHERE m.user_id = g.id))`;

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
  /** When the owner suspended the account; null while it is in good standing. */
  readonly suspendedAt: string | null;
  /** Whether the email is proven: a link followed or an owner's word (`core/verify.ts`). */
  readonly verified: boolean;
}

/** Every person (not an agent, not an organization) with role and model grant, newest first, in one query. */
export function listPeople(db: Database): Person[] {
  return db
    .query<{ username: string; is_admin: number; member: number | null; usd: number | null; suspended_at: string | null; verified_at: string | null }, []>(
      `SELECT u.username, u.is_admin, m.user_id AS member, g.usd_per_month AS usd, u.suspended_at, c.verified_at
       FROM user u
       LEFT JOIN member m ON m.user_id = u.id
       LEFT JOIN model_grant g ON g.user_id = u.id
       LEFT JOIN email_check c ON c.user_id = u.id
       WHERE u.kind = 'user' AND u.is_agent = 0 AND u.removed_at IS NULL
       ORDER BY u.created_at DESC, u.username`,
    )
    .all()
    .map((r) => ({
      username: r.username,
      role: r.is_admin === 1 ? "admin" : r.member !== null ? "member" : "guest",
      usdPerMonth: r.usd,
      suspendedAt: r.suspended_at,
      verified: r.verified_at !== null,
    }));
}
