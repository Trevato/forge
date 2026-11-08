/**
 * Forge it: one repository becomes the app of a fresh forge. The page's
 * button and the terminal's palette entry both come here, so the name and
 * the spawn are the same in both. It is the spawn door with the choices made.
 */

import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { Ctx } from "../http/context.ts";
import { spawnDoor, type Door } from "./door.ts";
import { CHILD_NAME } from "./placement.ts";

/** A forge name from a repository name: lowercase, dashes, at most 38 characters. */
export function forgeNameOf(repoName: string): string {
  const slug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38)
    .replace(/-+$/, "");
  return CHILD_NAME.test(slug) ? slug : "forge";
}

/** Make the forge (the door refuses what a person may not do). */
export const forgeIt = (ctx: Ctx, user: User, repo: Repo): Promise<Door> =>
  spawnDoor(ctx, user, {
    name: forgeNameOf(repo.name),
    apps: [`${repo.ownerName}/${repo.name}`],
    dryRun: false,
  });
