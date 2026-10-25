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
