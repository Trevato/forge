/**
 * What the changelog says about a closed chapter, shared by the page and the
 * terminal so they cannot disagree (#11868): which moments belong to it, and
 * its closing note in plain words.
 *
 * Membership is by time, not by tag: a pull or release belongs to the chapter
 * that was open when it landed (opened < at <= closed, the tag standing at the
 * default branch's tip at the close). A landing at the very edge of a window
 * can be placed in the neighbouring chapter; the chapter's own page, which
 * reads its issues, is the exact record.
 */

import type { Chapter } from "../core/chapters.ts";

/** A chapter that may head a group: closed, tagged and closed no later than `now`. */
export function isDrawable(c: Chapter, now: Date): boolean {
  return c.state === "closed" && c.tagOid !== null && c.closedAt !== null && Date.parse(c.closedAt) <= now.getTime();
}

/** Whether `at` (an ISO time) falls inside the chapter's window. */
export function inChapter(c: Chapter, at: string): boolean {
  const t = Date.parse(at);
  return c.closedAt !== null && Date.parse(c.openedAt ?? c.createdAt) < t && t <= Date.parse(c.closedAt);
}

/** Longest the first sentence of a note is shown. */
const MOST = 200;

/**
 * The first sentence of a closing note as plain words: markdown headings, emphasis,
 * code marks, list bullets and link syntax are dropped (a link keeps its text).
 * Empty when the note says nothing in words.
 */
export function noteWords(notes: string): string {
  const body = notes
    .split("\n")
    .filter((line) => !/^\s*#{1,6}\s/.test(line) && !/^\s*(```|~~~)/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const stop = body.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? body : body.slice(0, stop + 1);
  return sentence.length > MOST ? `${sentence.slice(0, MOST - 1).trimEnd()}…` : sentence;
}
