/**
 * Crew teams: a named group of agents with a charter (what it owns, what it
 * reviews) and a dial (0-100, its share of builder slots and budget). The
 * dials of all teams never sum past 100. Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";

export const CHARTER_MAX = 2_000;
export const DIAL_MAX = 100;

export interface Team {
  readonly slug: string;
  readonly name: string;
  readonly charter: string;
  readonly dial: number;
  /** User ids of the agents on the team. */
  readonly members: string[];
}

export type TeamError = "not_found" | "bad_dial" | "bad_charter" | "over_100" | "bad_member";

export function listTeams(db: Database): Team[] {
  const members = new Map<string, string[]>();
  for (const m of db
    .query<{ team_slug: string; user_id: string }, []>(
      "SELECT team_slug, user_id FROM crew_team_member ORDER BY user_id",
    )
    .all()) {
    const list = members.get(m.team_slug) ?? [];
    list.push(m.user_id);
    members.set(m.team_slug, list);
  }
  return db
    .query<{ slug: string; name: string; charter: string; dial: number }, []>(
      "SELECT slug, name, charter, dial FROM crew_team ORDER BY rowid",
    )
    .all()
    .map((t) => ({ ...t, members: members.get(t.slug) ?? [] }));
}

export function getTeam(db: Database, slug: string): Team | undefined {
  return listTeams(db).find((t) => t.slug === slug);
}

/** A dial: a whole number from 0 to 100, nothing else. */
export function parseDial(raw: unknown): Result<number, "bad_dial"> {
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw.trim())) return err("bad_dial");
  const n = Number(raw.trim());
  return n <= DIAL_MAX ? ok(n) : err("bad_dial");
}

/** Why `input` would be refused for `slug`, or undefined: what a save checks, without writing. */
export function refusal(
  db: Database,
  slug: string,
  input: { charter: string; dial: number; members: string[] },
): TeamError | undefined {
  if (input.charter.length > CHARTER_MAX) return "bad_charter";
  if (!Number.isInteger(input.dial) || input.dial < 0 || input.dial > DIAL_MAX) return "bad_dial";
  if (!db.query("SELECT 1 FROM crew_team WHERE slug = ?1").get(slug)) return "not_found";
  const others = db
    .query<{ s: number }, [string]>(
      "SELECT COALESCE(SUM(dial), 0) AS s FROM crew_team WHERE slug <> ?1",
    )
    .get(slug)!.s;
  if (others + input.dial > DIAL_MAX) return "over_100";
  for (const id of input.members)
    if (!db.query("SELECT 1 FROM agent WHERE user_id = ?1").get(id)) return "bad_member";
  return undefined;
}

/**
 * Set a team's charter, dial and members in one transaction. The dials of
 * the other teams plus this one must not pass 100; members must be agents.
 */
export function saveTeam(
  db: Database,
  slug: string,
  input: { charter: string; dial: number; members: string[] },
): Result<Team, TeamError> {
  const members = [...new Set(input.members)];
  const save = db.transaction((): TeamError | undefined => {
    const refused = refusal(db, slug, { ...input, members });
    if (refused) return refused;
    db.query("UPDATE crew_team SET charter = ?2, dial = ?3 WHERE slug = ?1").run(
      slug,
      input.charter,
      input.dial,
    );
    db.query("DELETE FROM crew_team_member WHERE team_slug = ?1").run(slug);
    for (const id of members)
      db.query("INSERT INTO crew_team_member (team_slug, user_id) VALUES (?1, ?2)").run(slug, id);
    return undefined;
  });
  const failed = save();
  if (failed) return err(failed);
  return ok(getTeam(db, slug)!);
}
