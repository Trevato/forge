/**
 * Where foundry is, when it is installed here (#8955): the open address of
 * the app whose slug is `foundry`, for a signed-in reader who may enter it.
 * Foundry is an app, not forge code: nothing depends on it, and when it is
 * not installed (or not the reader's to see) there is no door at all.
 */
import { getUserById } from "../core/users.ts";
import { getAppBySlug } from "../core/apps.ts";
import { canRead, enterableApps, getRepoById } from "../core/repos.ts";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";

export const FOUNDRY_SLUG = "foundry";

/** The forge's own org: its apps are as trusted as an admin's. */
export const FOUNDRY_ORG = "trevato";

/** How long a reader's answer is reused: the door moves when an app is installed, not per page. */
export const DOOR_TTL_MS = 5000;

const kept = new WeakMap<App, Map<string, { at: number; href: string | undefined }>>();

/**
 * Foundry's open address for `user`, or undefined. The common forge has no
 * app with the slug, so that one indexed read comes first and ends the work;
 * the rest is held for `DOOR_TTL_MS` per reader.
 */
export function foundryHref(app: App, user: User | undefined, now = Date.now()): string | undefined {
  if (user === undefined) return undefined;
  let mine = kept.get(app);
  if (mine === undefined) kept.set(app, (mine = new Map()));
  const held = mine.get(user.id);
  if (held !== undefined && now - held.at < DOOR_TTL_MS) return held.href;
  const href = resolve(app, user);
  if (mine.size > 200) mine.clear();
  mine.set(user.id, { at: now, href });
  return href;
}

function resolve(app: App, user: User): string | undefined {
  const db = app.db;
  const record = getAppBySlug(db, FOUNDRY_SLUG);
  if (record === undefined) return undefined;
  const repo = getRepoById(db, record.repoId);
  if (repo === undefined) return undefined;
  // The slug is first come, first served: only an app an admin or the
  // forge's own org owns is Foundry, or the link would be anyone's to plant.
  if (repo.ownerName.toLowerCase() !== FOUNDRY_ORG && getUserById(db, repo.ownerId)?.isAdmin !== true) return undefined;
  if (!canRead(db, repo, user)) return undefined;
  if (!enterableApps(db, [{ repo, app: record }], user, { named: false }).has(record.id)) return undefined;
  return `/${repo.ownerName}/${repo.name}/app/production/open`;
}
