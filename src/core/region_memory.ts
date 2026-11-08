/**
 * What a viewer was last shown, per region of a page, as plain text (#7660).
 * Nothing here knows what a region is: the caller names the viewer, the
 * region and a variant it has already validated, and gets back what it put
 * in. The key starts with the viewer, so no one reads another's, and every
 * viewer holds at most `PER_VIEWER` entries, so one viewer's keys can only
 * push out their own.
 */
import type { Database } from "bun:sqlite";

export interface Remembered {
  readonly html: string;
  readonly stamp: string | undefined;
  readonly at: number;
  /** What the viewer could see when it was drawn; a copy is only recalled for the same. */
  readonly access: string;
}

const KEEP_MS = 10 * 60_000;
const PER_VIEWER = 16;
const MAX_VIEWERS = 256;

const stores = new WeakMap<Database, Map<string, Map<string, Remembered>>>();

const storeOf = (db: Database): Map<string, Map<string, Remembered>> => {
  let s = stores.get(db);
  if (s === undefined) stores.set(db, (s = new Map()));
  return s;
};

/** What was remembered for this viewer's region and variant, if it is not older than ten minutes. */
export function recall(db: Database, viewerId: string, region: string, variant: string, access: string): Remembered | undefined {
  const had = stores.get(db)?.get(viewerId)?.get(`${region}\0${variant}`);
  return had !== undefined && had.access === access && Date.now() - had.at < KEEP_MS ? had : undefined;
}

export function remember(db: Database, viewerId: string, region: string, variant: string, html: string, stamp: string | undefined, access: string): void {
  const s = storeOf(db);
  const mine = s.get(viewerId) ?? new Map<string, Remembered>();
  s.delete(viewerId);
  s.set(viewerId, mine);
  const key = `${region}\0${variant}`;
  mine.delete(key);
  mine.set(key, { html, stamp, at: Date.now(), access });
  if (mine.size > PER_VIEWER) mine.delete(mine.keys().next().value as string);
  if (s.size > MAX_VIEWERS) s.delete(s.keys().next().value as string);
}

/** Drop what is remembered for one viewer: one region, or all of it. For when they changed what it shows, or their access did. */
export function forgetRegion(db: Database, viewerId: string, region?: string): void {
  const mine = stores.get(db)?.get(viewerId);
  if (mine === undefined) return;
  if (region === undefined) stores.get(db)?.delete(viewerId);
  else for (const k of [...mine.keys()]) if (k.startsWith(`${region}\0`)) mine.delete(k);
}

/** Drop everything remembered: for tests. */
export function forgetAll(db: Database): void {
  stores.delete(db);
}
