/**
 * Turning a valve (`flow/valve.ts`): the one writer of a level. A forge
 * admin who is a person turns it; an agent is told `not_found`, whatever it
 * was granted, because a valve is how the owner directs the crew and the
 * crew must not direct itself. A turn is kept, announced as `valve.turned`,
 * and read by the next tick. Accepting a suggestion is a turn the person
 * makes: the level is worked out again here, never taken from the caller.
 */

import type { App } from "../app.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { levelWords, parseLevel, suggestedLevel } from "../flow/valve.ts";
import { looksThisWeek, readLevels, turnValve } from "../flow/valve_store.ts";

export type ValveError = "not_found" | "invalid_level";

function person(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

function repoOf(app: App, slug: string): Repo | undefined {
  const [owner, name, ...rest] = slug.split("/");
  if (owner === undefined || name === undefined || rest.length > 0) return undefined;
  return getRepo(app.db, owner, name);
}

export interface Turned {
  readonly repo: string;
  readonly from: number;
  readonly to: number;
  readonly says: string;
}

function turn(app: App, who: User, repo: Repo, level: number): Turned {
  const { from, to } = turnValve(app.db, repo.id, level, who.id);
  const slug = `${repo.ownerName}/${repo.name}`;
  if (from !== to)
    app.bus.append({
      kind: "valve.turned",
      actorId: who.id,
      repoId: repo.id,
      payload: { repo: slug, from, to },
    });
  return { repo: slug, from, to, says: `${slug}: ${levelWords(to)} From the next tick on.` };
}

/** Set a repository's valve to `level` (0 shut, 1 to 99 a share, 100 open). */
export function turnValveFor(app: App, actor: User | undefined, slug: string, level: unknown): Result<Turned, ValveError> {
  const who = person(actor);
  if (!who.ok) return who;
  const repo = repoOf(app, slug);
  if (repo === undefined) return err("not_found");
  const n = parseLevel(level);
  if (n === undefined) return err("invalid_level");
  return ok(turn(app, who.value, repo, n));
}

/** Take the suggestion beside a valve, as it stands now; nothing when there is none. */
export function acceptSuggestion(app: App, actor: User | undefined, slug: string): Result<Turned, ValveError> {
  const who = person(actor);
  if (!who.ok) return who;
  const repo = repoOf(app, slug);
  if (repo === undefined) return err("not_found");
  const current = readLevels(app.db).get(repo.id) ?? 100;
  const level = suggestedLevel(looksThisWeek(app.db, who.value.id), repo.id, current);
  if (level === undefined) return err("invalid_level");
  return ok(turn(app, who.value, repo, level));
}
