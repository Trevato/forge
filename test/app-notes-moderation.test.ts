/**
 * Moderation of the notes visitors leave in an app (`core/app_notes.ts`):
 * hide one note, ban a sender (their notes leave the owner's list, only for
 * that app), unban (the ban lifts; notes hidden with it stay hidden, as the
 * module documents), and the limits that cap each list.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import migration from "../src/core/migrations/20261022130000-app-notes.ts";
import {
  banVisitor,
  bannedNotes,
  hideNote,
  insertNote,
  isBanned,
  notesOf,
  notesOfApp,
  unbanVisitor,
} from "../src/core/app_notes.ts";

let db: Database;
const add = (appId: string, visitor: string, n: number) =>
  insertNote(db, { appId, repoId: "r", issueNumber: n, visitor, name: `n${n}` });

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(migration);
});

describe("app note moderation", () => {
  test("notesOfApp lists the app's notes and none of another app's", () => {
    add("a", "v1", 1);
    add("a", "v2", 2);
    add("b", "v1", 3);
    expect(notesOfApp(db, "a").map((n) => n.issueNumber).sort()).toEqual([1, 2]);
    expect(notesOfApp(db, "b").map((n) => n.issueNumber)).toEqual([3]);
  });

  test("hideNote removes one note from the app list and the visitor's own list", () => {
    const first = add("a", "v1", 1);
    add("a", "v1", 2);
    add("a", "v2", 3);
    hideNote(db, first.id);
    expect(notesOfApp(db, "a").map((n) => n.issueNumber).sort()).toEqual([2, 3]);
    expect(notesOf(db, "a", "v1").map((n) => n.issueNumber)).toEqual([2]);
  });

  test("banVisitor hides that visitor's notes on that app only; unbanVisitor lifts the ban", () => {
    add("a", "v1", 1);
    const latest = add("a", "v1", 2);
    add("a", "v2", 3);
    add("b", "v1", 4);
    banVisitor(db, "a", "v1");
    expect(isBanned(db, "a", "v1")).toBe(true);
    expect(isBanned(db, "b", "v1")).toBe(false);
    expect(notesOfApp(db, "a").map((n) => n.issueNumber)).toEqual([3]);
    expect(notesOf(db, "a", "v1")).toEqual([]);
    expect(notesOfApp(db, "b").map((n) => n.issueNumber)).toEqual([4]);
    // each banned sender once, as their latest note; other apps list none
    expect(bannedNotes(db, "a").map((n) => n.id)).toEqual([latest.id]);
    expect(bannedNotes(db, "b")).toEqual([]);

    unbanVisitor(db, "a", "v1");
    expect(isBanned(db, "a", "v1")).toBe(false);
    expect(bannedNotes(db, "a")).toEqual([]);
    // the notes hidden with the ban stay hidden; new ones show
    expect(notesOfApp(db, "a").map((n) => n.issueNumber)).toEqual([3]);
    add("a", "v1", 5);
    expect(notesOfApp(db, "a").map((n) => n.issueNumber).sort()).toEqual([3, 5]);
  });

  test("the limit arguments cap each list", () => {
    for (let i = 1; i <= 4; i++) add("a", "v1", i);
    add("a", "v2", 5);
    add("a", "v3", 6);
    banVisitor(db, "a", "v2");
    banVisitor(db, "a", "v3");
    add("a", "v1", 7);
    expect(notesOfApp(db, "a", 2)).toHaveLength(2);
    expect(notesOf(db, "a", "v1", 3)).toHaveLength(3);
    expect(bannedNotes(db, "a", 1)).toHaveLength(1);
    expect(bannedNotes(db, "a")).toHaveLength(2);
  });
});
