/**
 * The sentences said in more than one place — the web page and the terminal
 * screen — typed out once, here, so they read the same wherever they are said.
 * Plain strings in, plain strings (or parts) out; each door does its own
 * escaping and layout.
 */

import type { DeciderPile } from "../core/decisions.ts";

/** A repository's waves, empty because there is no `waves/` to read. */
export const NO_WAVES = "This repository has no waves/ directory.";

/**
 * "The decider closed 4, deferred 2, asked you about 1." as its parts, each
 * count as `count` renders it: the terminal joins the numbers, the board
 * links each one to its ledger rows.
 */
export function deciderSentence<T>(count: (pile: DeciderPile) => T): (string | T)[] {
  return [
    "The decider closed ",
    count("closed"),
    ", deferred ",
    count("deferred"),
    ", asked you about ",
    count("asked"),
    ".",
  ];
}

/** The longest a wave's opening sentence runs, in characters. */
export const WAVE_SENTENCE_CAP = 160;
/** Up to this many landed titles are named in the sentence; more are counted. */
export const WAVE_NAMED_MAX = 2;
/** Said when no pull of the wave has landed. */
export const WAVE_NOTHING_LANDED = "No pull in this wave has landed yet.";

const squash = (s: string): string => s.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().replace(/[.!?]+$/, "");

/**
 * One plain sentence of what a wave changed, from the titles of its landed
 * pulls: deterministic, no model, at most `WAVE_SENTENCE_CAP` characters. The
 * titles are the writers' words and come back unescaped; the page escapes them.
 */
export function waveSentence(titles: readonly string[], cap = WAVE_SENTENCE_CAP): string {
  const all = titles.map(squash).filter((t) => t !== "");
  if (all.length === 0) return WAVE_NOTHING_LANDED;
  // Many titles would only be the pull rows said twice: count them, name the first.
  if (all.length > WAVE_NAMED_MAX) {
    const head = `${all.length} changes landed, starting with `;
    const keep = Math.max(1, cap - head.length - 2);
    const first = all[0]!;
    return `${head}${first.length > keep ? `${first.slice(0, keep - 1).trimEnd()}…` : first}.`;
  }
  const lead = "This wave landed ";
  const text = all.join(" and ");
  const room = cap - lead.length - 1;
  return `${lead}${text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text}.`;
}
