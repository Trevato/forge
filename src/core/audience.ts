/**
 * Who can see a repository or an app, in one sentence.
 *
 * `audienceOf` is pure: plain facts in, a level and a sentence out, so every
 * wording is a test with no database. `audienceFacts` reads the facts, and
 * asks the same two rules the forge enforces — `REPO_VISIBLE` and
 * `REPO_WRITABLE` — once per candidate, so the sentence cannot drift from
 * what the forge lets through. Site admins are not counted: their reach is
 * the forge's, not the repository's. Nor are suspended or removed accounts.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "./repos.ts";
import type { User } from "./users.ts";
import { REPO_VISIBLE, REPO_WRITABLE } from "./visibility.ts";

export interface AudienceFacts {
  readonly visibility: "public" | "private";
  /** Who is looking: nobody signed in, a person, or a site admin. */
  readonly viewer: "signed-out" | "person" | "admin";
  readonly ownerKind: "user" | "org";
  readonly ownerName: string;
  /** People (not the crew) other than the viewer who may read it. */
  readonly readers: number;
  /** People (not the crew) who may change it, the viewer among them. */
  readonly writers: number;
  readonly viewerWrites: boolean;
  /** Whether any of the crew works here. */
  readonly crew: boolean;
  /**
   * The app's access, when the repository has an app. People are counted
   * once, never the viewer: `writers` may change the repository, `named` are
   * named by the app and cannot.
   */
  readonly app?: {
    readonly access: "public" | "private";
    readonly writers: number;
    readonly named: number;
    readonly viewerNamed: boolean;
  };
}

export interface Audience {
  /** `split`: public code, private app. */
  readonly level: "public" | "private" | "split";
  readonly sentence: string;
}

/**
 * Who may read the repository, as one word a client can branch on: its
 * owner (and the owner's crew), the members of the organization that owns
 * it, or anyone. The sentence says the same thing for a person to read.
 */
export type Who = "owner" | "members" | "anyone";

export function whoOf(facts: Pick<AudienceFacts, "visibility" | "ownerKind">): Who {
  if (facts.visibility === "public") return "anyone";
  return facts.ownerKind === "org" ? "members" : "owner";
}

const people = (n: number): string => (n === 1 ? "1 person" : `${n} people`);

/** "a", "a and b", "a, b, and c". */
function list(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function audienceOf(facts: AudienceFacts): Audience {
  const crew = facts.crew ? ["the crew"] : [];
  // "you" is only said to someone signed in.
  const you = facts.viewer === "signed-out" ? [] : ["you"];
  if (facts.visibility === "public") {
    if (facts.app?.access === "private") {
      // Only someone who can change it, or is named, is told "you".
      const youToo =
        you.length > 0 && (facts.viewerWrites || facts.app.viewerNamed)
          ? you
          : [];
      const parts = [
        ...youToo,
        ...(facts.app.writers > 0
          ? [`${people(facts.app.writers)} who can change it`]
          : []),
        ...(facts.app.named > 0 ? [`${people(facts.app.named)} it names`] : []),
        ...crew,
      ];
      return {
        level: "split",
        sentence: `The code is public; the app answers only to ${
          parts.length === 0 ? "nobody" : list(parts)
        }.`,
      };
    }
    const changers = [
      ...(facts.writers > 0 ? [people(facts.writers)] : []),
      ...crew,
    ];
    return {
      level: "public",
      sentence: `Public: anyone can read this; ${
        changers.length === 0 ? "nobody" : list(changers)
      } can change it.`,
    };
  }
  const parts = [...you];
  if (facts.readers > 0) {
    parts.push(
      facts.ownerKind === "org"
        ? `${people(facts.readers)} in ${facts.ownerName}`
        : facts.ownerName,
    );
  }
  const alone = parts.length === 1 && you.length === 1;
  parts.push(...crew);
  return {
    level: "private",
    sentence: `Private: ${alone ? "only " : ""}${
      parts.length === 0 ? "nobody" : list(parts)
    }.`,
  };
}

/** How many active, non-admin people satisfy `rule` (over `?1` = repo id). */
function countPeople(
  db: Database,
  repoId: string,
  rule: string,
  exceptId: string | undefined,
): number {
  // The rules take the person as `?1`; here each candidate is that person.
  const asCandidate = rule.replaceAll("?1", "cand.id");
  return db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM user AS cand
        WHERE cand.kind = 'user' AND cand.is_agent = 0 AND cand.is_admin = 0
          AND cand.suspended_at IS NULL AND cand.removed_at IS NULL
          AND cand.id != ?2
          AND EXISTS (SELECT 1 FROM repo WHERE repo.id = ?1 AND ${asCandidate})`,
    )
    .get(repoId, exceptId ?? "")!.n;
}

/**
 * `REPO_WRITABLE` without its site-admin clause: an admin's reach is the
 * forge's, so only membership of the repository itself earns them "you".
 * Throws if the rule is reshaped, so a drift cannot go unnoticed.
 */
const MEMBER_WRITABLE = REPO_WRITABLE.replace(
  /\n\s*OR EXISTS \(SELECT 1 FROM user AS me WHERE me\.id = \?1 AND me\.is_admin = 1\)/,
  "",
);
if (MEMBER_WRITABLE === REPO_WRITABLE) {
  throw new Error("audience: REPO_WRITABLE lost its admin clause; update audience.ts");
}

export function audienceFacts(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): AudienceFacts {
  const owner = db
    .query<{ kind: "user" | "org" }, [string]>(
      "SELECT kind FROM user WHERE id = ?1",
    )
    .get(repo.ownerId);
  const viewerId = viewer?.id;
  const writes =
    viewerId !== undefined &&
    db
      .query<{ n: number }, [string, string]>(
        `SELECT 1 AS n FROM repo WHERE repo.id = ?1 AND ${MEMBER_WRITABLE.replaceAll("?1", "?2")}`,
      )
      .get(repo.id, viewerId) !== null;
  const app = db
    .query<{ id: string; access: "public" | "private" }, [string]>(
      "SELECT id, access FROM app WHERE repo_id = ?1",
    )
    .get(repo.id);
  const namedRule = `EXISTS (SELECT 1 FROM app_member AS m WHERE m.app_id = ?1 AND m.user_id = cand.id)`;
  const activePerson = `cand.kind = 'user' AND cand.is_agent = 0 AND cand.is_admin = 0
          AND cand.suspended_at IS NULL AND cand.removed_at IS NULL`;
  const named = app
    ? db
        .query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM user AS cand
            WHERE ${activePerson} AND cand.id != ?3 AND ${namedRule}
              AND NOT EXISTS (SELECT 1 FROM repo WHERE repo.id = ?2 AND ${REPO_WRITABLE.replaceAll("?1", "cand.id")})`,
        )
        .get(app.id, repo.id, viewerId ?? "")!.n
    : 0;
  const viewerNamed =
    app !== null &&
    viewerId !== undefined &&
    db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM app_member WHERE app_id = ?1 AND user_id = ?2",
      )
      .get(app.id, viewerId) !== null;
  return {
    visibility: repo.visibility,
    viewer:
      viewer === undefined ? "signed-out" : viewer.isAdmin ? "admin" : "person",
    ownerKind: owner?.kind ?? "user",
    ownerName: repo.ownerName,
    readers: countPeople(db, repo.id, REPO_VISIBLE, viewerId),
    writers: countPeople(db, repo.id, REPO_WRITABLE, undefined),
    viewerWrites: writes,
    crew:
      db
        .query<{ n: number }, [string]>(
          "SELECT 1 AS n FROM repo_crew WHERE repo_id = ?1",
        )
        .get(repo.id) !== null,
    ...(app
      ? {
          app: {
            access: app.access,
            writers: countPeople(db, repo.id, REPO_WRITABLE, viewerId),
            named,
            viewerNamed,
          },
        }
      : {}),
  };
}

/** The audience of `repo` for `viewer`: the one call the API and the MCP share. */
export function audienceFor(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): Audience & { readonly who: Who } {
  const facts = audienceFacts(db, repo, viewer);
  return { ...audienceOf(facts), who: whoOf(facts) };
}
