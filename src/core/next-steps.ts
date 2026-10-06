/**
 * The first steps on a spawned forge (#600): what its new owner does after
 * the claim — make an everyday account, open an app, tell the crew
 * something — each read from what has happened, never ticked by hand.
 *
 * Only on a spawned forge (it has a `parent.json`) and only for its owner:
 * a site admin, or the everyday account of one. The steps are the owner's
 * whichever of the two is signed in, so making the everyday account moves
 * the card to that account without starting it over.
 */

import type { App } from "../app.ts";
import { spawnedOrg } from "../spawn/claim.ts";
import { adminOf, everydayOf, keptAdmin } from "./everyday.ts";
import { listReposByOwner, type Repo } from "./repos.ts";
import { getUserSetting, setUserSetting } from "./settings.ts";
import type { User } from "./users.ts";

export type StepKey = "everyday" | "apps" | "tell";

export interface NextStep {
  readonly key: StepKey;
  readonly title: string;
  readonly done: boolean;
}

const OPENED_APP = "first_step_opened_app";

/** The admin whose forge this is, as seen by `user`: themselves, or the admin of their everyday account. */
function ownerFor(app: App, user: User): User | undefined {
  if (user.kind !== "user") return undefined;
  if (user.isAdmin) return user;
  const admin = adminOf(app.db, user);
  return admin?.isAdmin ? admin : undefined;
}

/**
 * The three steps and whether each is done, for the owner of a spawned
 * forge; undefined for anyone else, or on a forge that was not spawned.
 */
export async function nextStepsFor(
  app: App,
  user: User | undefined,
): Promise<readonly NextStep[] | undefined> {
  if (!user) return undefined;
  const owner = ownerFor(app, user);
  if (!owner) return undefined;
  if ((await spawnedOrg(app)) === undefined) return undefined;
  const daily = everydayOf(app.db, owner);
  const people = [owner.id, ...(daily ? [daily.id] : [])];
  const told = app.db
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM issue i
       WHERE i.kind = 'issue' AND i.author_id IN (${people.map((_, n) => `?${n + 1}`).join(",")})
         AND i.id NOT IN (SELECT direction_issue_id FROM repo WHERE direction_issue_id IS NOT NULL)`,
    )
    .get(...people);
  return [
    {
      key: "everyday",
      title: "Make your everyday account",
      done: daily !== undefined || keptAdmin(app.db, owner),
    },
    {
      key: "apps",
      title: "Open your apps",
      done: getUserSetting(app.db, owner.id, OPENED_APP) !== undefined,
    },
    { key: "tell", title: "Tell the crew something", done: (told?.n ?? 0) > 0 },
  ];
}

/** The owner (or their everyday account) opened an app on a spawned forge: the second step is done. */
export async function noteAppOpened(app: App, user: User | undefined): Promise<void> {
  if (!user) return;
  const owner = ownerFor(app, user);
  if (!owner || getUserSetting(app.db, owner.id, OPENED_APP) !== undefined) return;
  if ((await spawnedOrg(app)) === undefined) return;
  setUserSetting(app.db, owner.id, OPENED_APP, new Date().toISOString());
}

/** The spawned organisation's apps, for the second step's links. */
export async function spawnedRepos(
  app: App,
  user: User,
): Promise<readonly Repo[]> {
  const spawned = await spawnedOrg(app);
  if (!spawned) return [];
  return listReposByOwner(app.db, spawned.org.username, user, { limit: 50 });
}
