/**
 * The repos an admin has marked as packs (#10532): the `packs.repos` row in
 * `forge_setting`, a JSON list of `owner/name`. /packs shows exactly these and
 * nothing else; a repo not on the list is not a pack, whatever it holds.
 * Edited on /settings/packs, with every change kept in `forge_setting_change`.
 */

import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";

export const PACKS_REPOS_KEY = "packs.repos";
export const MAX_MARKED = 20;

/** `owner/name` words from free text, and the words that were not that. */
export function parseMarked(text: string): { repos: string[]; rejected: string[] } {
  const repos: string[] = [];
  const rejected: string[] = [];
  for (const word of text.slice(0, 4000).split(/[\s,]+/)) {
    if (word === "") continue;
    const [owner = "", name = "", ...rest] = word.split("/");
    const full = `${owner}/${name}`.toLowerCase();
    if (rest.length > 0 || !isSafeName(owner) || !isSafeName(name) || (repos.length >= MAX_MARKED && !repos.includes(full)))
      rejected.push(word.slice(0, 60));
    else if (!repos.includes(full)) repos.push(full);
  }
  return { repos, rejected };
}

/** The marked repos, in the order they were listed. Unset or unreadable is none. */
export function markedRepos(db: Database): string[] {
  try {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(PACKS_REPOS_KEY);
    const parsed: unknown = row ? JSON.parse(row.value) : [];
    return Array.isArray(parsed) ? parseMarked(parsed.filter((v) => typeof v === "string").join(" ")).repos : [];
  } catch {
    return [];
  }
}

/** Replace the list and keep the change. */
export function saveMarkedRepos(db: Database, repos: readonly string[], actorId: string): void {
  const at = new Date().toISOString();
  const to = JSON.stringify(repos);
  db.transaction(() => {
    const from = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(PACKS_REPOS_KEY)?.value;
    db.query(
      `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(PACKS_REPOS_KEY, to, actorId, at);
    db.query(
      `INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).run(PACKS_REPOS_KEY, from ?? "[]", to, actorId, at);
  })();
}

export type MarkedUpdate =
  | { ok: true; repos: string[] }
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "rejected"; rejected: string[] };

/** The one door: an admin who is not an agent; check, save, keep. */
export function updateMarkedRepos(
  db: Database,
  user: { id: string; isAdmin: boolean; kind: string } | undefined,
  text: string,
): MarkedUpdate {
  if (user === undefined || !user.isAdmin || user.kind === "agent") return { ok: false, error: "forbidden" };
  const { repos, rejected } = parseMarked(text);
  if (rejected.length > 0) return { ok: false, error: "rejected", rejected };
  saveMarkedRepos(db, repos, user.id);
  return { ok: true, repos };
}

export const rejectedMarkedSentence = (rejected: readonly string[]): string =>
  `Not owner/name repositories: ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? " …" : ""}. Use words like packs/games.`;
