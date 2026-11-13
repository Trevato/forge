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
import { spawnedForge } from "../spawn/claim.ts";
import { adminOf, everydayOf, keptAdmin } from "./everyday.ts";
import { listReposByOwner, type Repo } from "./repos.ts";
import { PREVIEW_SEEDED, getUserSetting, setUserSetting } from "./settings.ts";
import { getUserById, type User } from "./users.ts";

export type StepKey = "everyday" | "apps" | "tell";

export interface NextStep {
  readonly key: StepKey;
  readonly title: string;
  readonly done: boolean;
}

const STEP_KEYS: readonly StepKey[] = ["everyday", "apps", "tell"];

/** The three steps' words, the one source for the first-login card and the client list's line about it. */
export const STEP_TITLES: Record<StepKey, string> = {
  everyday: "Make your everyday account",
  apps: "Open your apps",
  tell: "Tell the crew something",
};

/** What the recipient of a sent forge sees first, in one line: the apps chosen, that the crew is working, the three steps. */
export function firstScreenLine(apps: readonly string[]): string {
  const chosen = apps.length === 0 ? "the apps you pick" : apps.join(", ");
  return `They will see ${chosen}, their crew working, and three next steps: ${STEP_KEYS.map((k) => STEP_TITLES[k]).join("; ")}.`;
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
  // The preview admin is a site admin of a seeded world, not a newcomer: its
  // home stays the full one though the preview has a parent.json (#11285).
  if (getUserSetting(app.db, owner.id, PREVIEW_SEEDED) !== undefined) return undefined;
  if ((await spawnedForge(app)) === undefined) return undefined;
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
      title: STEP_TITLES.everyday,
      done: daily !== undefined || keptAdmin(app.db, owner),
    },
    {
      key: "apps",
      title: STEP_TITLES.apps,
      done: getUserSetting(app.db, owner.id, OPENED_APP) !== undefined,
    },
    { key: "tell", title: STEP_TITLES.tell, done: (told?.n ?? 0) > 0 },
  ];
}

/**
 * Where this forge's person stands, for the heartbeat: claimed, whether they
 * have an everyday account (or chose to keep working as admin), and when
 * they last told the crew something (null before the first tell).
 */
export function progress(app: App): { claimed: boolean; everyday: boolean; lastTellAt: string | null } {
  const owner = app.db
    .query<{ id: string }, []>(
      "SELECT id FROM user WHERE is_admin = 1 AND is_agent = 0 AND kind = 'user' ORDER BY created_at LIMIT 1",
    )
    .get();
  const admin = owner === null ? undefined : getUserById(app.db, owner.id);
  if (admin === undefined) return { claimed: false, everyday: false, lastTellAt: null };
  const daily = everydayOf(app.db, admin);
  const people = [admin.id, ...(daily ? [daily.id] : [])];
  const last = app.db
    .query<{ at: string | null }, string[]>(
      `SELECT MAX(i.created_at) AS at FROM issue i
       WHERE i.kind = 'issue' AND i.author_id IN (${people.map((_, n) => `?${n + 1}`).join(",")})
         AND i.id NOT IN (SELECT direction_issue_id FROM repo WHERE direction_issue_id IS NOT NULL)`,
    )
    .get(...people);
  return {
    claimed: true,
    everyday: daily !== undefined || keptAdmin(app.db, admin),
    lastTellAt: last?.at ?? null,
  };
}

/** The owner (or their everyday account) opened an app on a spawned forge: the second step is done. */
export async function noteAppOpened(app: App, user: User | undefined): Promise<void> {
  if (!user) return;
  const owner = ownerFor(app, user);
  if (!owner || getUserSetting(app.db, owner.id, OPENED_APP) !== undefined) return;
  if ((await spawnedForge(app)) === undefined) return;
  setUserSetting(app.db, owner.id, OPENED_APP, new Date().toISOString());
}

/** The spawned organisation's apps, for the second step's links. */
export async function spawnedRepos(
  app: App,
  user: User,
): Promise<readonly Repo[]> {
  const spawned = await spawnedForge(app);
  if (!spawned) return [];
  return listReposByOwner(app.db, spawned.org.username, user, { limit: 50 });
}
