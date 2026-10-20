/**
 * Pinned panels: a person's own list of panels from /boards that home draws
 * under the KPI row. A pin names a board's slug and a panel's title and sits
 * at a position in its owner's order; it is only ever read or changed with
 * its owner's id, so one person's pins are never another's.
 */
import type { Database } from "bun:sqlite";
import { isSlug, MAX_TITLE } from "./store.ts";

export type Pin = { slug: string; title: string };
export const MAX_PINS = 24;

/** A pin as a form says it, judged: the plain value or undefined. */
export function pinOf(slug: unknown, title: unknown): Pin | undefined {
  if (!isSlug(slug) || typeof title !== "string") return undefined;
  if (title.trim() === "" || title.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
  return { slug, title: title.trim() };
}

/** The owner's pins in their order. */
export function listPins(db: Database, userId: string): Pin[] {
  return db
    .query<Pin, [string]>("SELECT slug, title FROM board_pin WHERE user_id = ? ORDER BY pos, rowid")
    .all(userId);
}

export const isPinned = (pins: readonly Pin[], slug: string, title: string) =>
  pins.some((p) => p.slug === slug && p.title === title);

/** Pin at the end of the owner's order; false when they already hold the most. Pinning twice changes nothing. */
export function pin(db: Database, userId: string, p: Pin): boolean {
  const have = listPins(db, userId);
  if (isPinned(have, p.slug, p.title)) return true;
  if (have.length >= MAX_PINS) return false;
  db.run("INSERT INTO board_pin (user_id, slug, title, pos) VALUES (?, ?, ?, ?)", [userId, p.slug, p.title, have.length]);
  return true;
}

export function unpin(db: Database, userId: string, p: Pin): void {
  db.run("DELETE FROM board_pin WHERE user_id = ? AND slug = ? AND title = ?", [userId, p.slug, p.title]);
  renumber(db, userId, listPins(db, userId));
}

/** Move one step earlier (-1) or later (1); the ends stay put. */
export function movePin(db: Database, userId: string, p: Pin, by: -1 | 1): void {
  const list = listPins(db, userId);
  const i = list.findIndex((x) => x.slug === p.slug && x.title === p.title);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
  renumber(db, userId, list);
}

function renumber(db: Database, userId: string, list: readonly Pin[]): void {
  db.transaction(() => {
    list.forEach((x, pos) =>
      db.run("UPDATE board_pin SET pos = ? WHERE user_id = ? AND slug = ? AND title = ?", [pos, userId, x.slug, x.title]));
  })();
}
