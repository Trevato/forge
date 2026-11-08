/**
 * `forge asks --ship 1 3 --close 2 --reason "words" --dismiss 4`: the part of
 * the command line that names a decision. The numbers are the ones `forge
 * asks` printed; this module only reads them and maps them to ask ids from
 * the list it is handed — the caller reads that list fresh, never from a cache.
 */

import type { Ask } from "./api.ts";

export const DECISIONS = ["ship", "close", "dismiss"] as const;
export type Decision = (typeof DECISIONS)[number];

/** The most asks one decision takes: the API's own limit. */
export const MOST = 100;

export interface Wish {
  readonly action: Decision | "undo";
  /** The numbers as typed, in order, duplicates dropped; the receipt id for `undo`. */
  readonly numbers: readonly string[];
  readonly reason: string | undefined;
}

/** Flags of `forge asks` that take the next token as their value. */
const TAKES_VALUE = ["repo", "reason", "undo"];

/**
 * `Wish` for no decision at all (plain `forge asks`), or the words for a bad
 * line. `argv` is what follows `asks`. Numbers belong to the decision flag
 * they follow, up to the next flag; any other loose word is refused, never
 * silently dropped.
 */
export function parseWish(argv: readonly string[]): Wish | undefined | string {
  let action: Decision | undefined;
  const numbers: string[] = [];
  let reason: string | undefined;
  let undo: string | undefined;
  let into = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") {
        into = false;
        continue;
      }
      if (!into) return `unexpected "${arg}" — numbers follow --ship, --close or --dismiss`;
      if (!numbers.includes(arg)) numbers.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    into = false;
    if (TAKES_VALUE.includes(name)) {
      let value: string | undefined;
      if (eq >= 0) value = arg.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-"))
        value = argv[++i];
      if (name === "reason") {
        if (value === undefined || value.trim() === "")
          return "--reason needs words";
        reason = value.trim();
      } else if (name === "undo") {
        if (value === undefined || value.trim() === "")
          return "--undo needs the receipt id";
        undo = value.trim();
      }
      continue;
    }
    if ((DECISIONS as readonly string[]).includes(name)) {
      if (action !== undefined && action !== name)
        return `one decision at a time: --${action} or --${name}`;
      action = name as Decision;
      into = true;
    }
  }
  if (undo !== undefined) {
    if (action !== undefined || reason !== undefined)
      return "--undo stands alone";
    return { action: "undo", numbers: [undo], reason: undefined };
  }
  if (action === undefined) {
    return reason === undefined ? undefined : "--reason goes with --close";
  }
  if (numbers.length === 0) return `--${action} needs the numbers of the asks`;
  if (numbers.length > MOST)
    return `at most ${MOST} asks at once, not ${numbers.length}`;
  if (reason !== undefined && action !== "close")
    return "--reason goes with --close";
  return { action, numbers, reason };
}

/** The ask ids the numbers name, or the words that refuse them. */
export function pickAsks(
  numbers: readonly string[],
  rows: readonly Ask[],
): string[] | { refused: string } {
  const ids: string[] = [];
  for (const n of numbers) {
    const at = /^[1-9]\d{0,5}$/.test(n) ? Number(n) : 0;
    const ask = rows[at - 1];
    if (ask === undefined)
      return {
        refused: `no ask is numbered ${JSON.stringify(n).slice(1, -1)}${rows.length === 0 ? "" : ` (the list runs 1 to ${rows.length})`}`,
      };
    if (ask.id === undefined)
      return { refused: `${at} is the forge's own need, not an ask to decide here` };
    if (!ids.includes(ask.id)) ids.push(ask.id);
  }
  return ids;
}
