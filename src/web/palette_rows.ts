/**
 * The palette rows that depend on who is looking: the people, more settings
 * pages, and the actions. Plain data out. Every filter
 * runs here, on the server, before the list exists: a row the viewer may not
 * see is never serialised.
 */
import type { Database } from "bun:sqlite";
import { listPeople, type User } from "../core/users.ts";

/** One serialised palette row (the shape `PaletteItem` in layout.ts names). */
export interface PaletteRow {
  t: string;
  h: string;
  c: string;
  /** An action: the palette asks once before it runs. */
  a?: 1;
}

/** The people list is bounded: the palette is a local list, not a database. */
export const PALETTE_PEOPLE = 50;

/** Who is on the forge changes slowly: one read a half minute per database, not one per page. */
const PEOPLE_TTL_MS = 30_000;
const peopleCache = new WeakMap<Database, { at: number; rows: PaletteRow[] }>();

/** People, for a signed-in viewer only; accounts that are neither orgs nor agents. */
export function peopleRows(db: Database, user: User | undefined): PaletteRow[] {
  if (user === undefined) return [];
  let hit = peopleCache.get(db);
  if (hit === undefined || Date.now() - hit.at > PEOPLE_TTL_MS) {
    hit = {
      at: Date.now(),
      rows: listPeople(db, { limit: PALETTE_PEOPLE }).map((p) => ({
        t: p.username,
        h: `/${p.username}`,
        c: "People",
      })),
    };
    peopleCache.set(db, hit);
  }
  return hit.rows;
}

/** More settings pages than the static few; signed-in viewers only. */
export function settingsRows(user: User | undefined): PaletteRow[] {
  if (user === undefined) return [];
  return [
    { t: "Password", h: "/settings/password", c: "Settings" },
    { t: "Passkeys", h: "/settings/passkeys", c: "Settings" },
    { t: "Subscriptions", h: "/settings/subscriptions", c: "Settings" },
  ];
}

/**
 * Actions: what sends something rather than going somewhere, so it asks one
 * confirmation in the palette first. Only "Tell the crew" is one; "New app"
 * and "Map" are navigation (already in the list) and never carry `a`.
 * Signed-out viewers get none.
 */
export function actionRows(
  user: User | undefined,
  tellHref: string | undefined,
): PaletteRow[] {
  if (user === undefined) return [];
  return [
    ...(tellHref === undefined
      ? []
      : [{ t: "Tell the crew", h: tellHref, c: "Actions", a: 1 as const }]),
  ];
}
