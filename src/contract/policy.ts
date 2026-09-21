/**
 * A change to a contract is a change of policy, and the one kind that
 * needs a person is a cell loosened toward the floor: something a stranger
 * or a user could not do before that they could after. That is a wall —
 * decided up front, crossed only by a person — so a pull that crosses it
 * is shown, never landed on its own, whatever the checks say.
 *
 * Tightening needs nobody: a door that closes breaks nothing a person
 * decided to allow. Neither does a new resource whose cells are no looser
 * than the floor already was, or a contract appearing where there was none
 * with nothing open past reading.
 */

import { readFileAt } from "../apps/checkout.ts";
import type { Contract } from "./can.ts";
import { identities, readContract, table, type Cell } from "./can.ts";

export interface Loosened {
  readonly resource: string;
  readonly verb: Cell["verb"];
  readonly as: string;
  readonly answer: Cell["answer"];
  readonly from: Cell["answer"] | "absent";
  readonly to: Cell["answer"];
}

/** Rank: what a cell lets through, most to least. */
const RANK: Record<Cell["answer"], number> = { yes: 2, own: 1, no: 0 };

/**
 * The cells of `after` that let more through than `before` did. Against a
 * contract that was there, every identity counts: a decided cell that
 * opens is a decision undone. Where there was no contract, only the floor
 * counts: what a stranger may do is the one thing nobody decided yet.
 */
export function loosened(
  before: Contract | undefined,
  after: Contract,
): Loosened[] {
  const out: Loosened[] = [];
  const floor = identities(after).find(
    (n) => after.roles[n]!.held.by === "everyone",
  );
  if (before === undefined) {
    for (const c of table(after))
      if (c.as === floor && c.answer !== "no")
        out.push({ ...c, from: "absent", to: c.answer });
    return out;
  }
  const was = new Map(
    table(before).map((c) => [`${c.resource}.${c.verb}.${c.as}`, c.answer]),
  );
  for (const c of table(after)) {
    const from = was.get(`${c.resource}.${c.verb}.${c.as}`) ?? "no";
    if (RANK[c.answer] > RANK[from])
      out.push({
        ...c,
        from: was.has(`${c.resource}.${c.verb}.${c.as}`) ? from : "absent",
        to: c.answer,
      });
  }
  return out;
}

export interface Wall {
  /** What this head lets through that the base did not. */
  readonly loosened: readonly Loosened[];
  /** The head's contract does not read; a person decides that too. */
  readonly unsound?: readonly string[] | undefined;
}

/**
 * Whether a pull crosses the wall: its head's `contract.json` lets more
 * through than its base's. Undefined when the head changes no contract, or
 * neither side has one.
 */
export async function wallOf(
  dir: string,
  baseOid: string,
  headOid: string,
): Promise<Wall | undefined> {
  const [baseText, headText] = await Promise.all([
    readFileAt(dir, baseOid, "contract.json"),
    readFileAt(dir, headOid, "contract.json"),
  ]);
  if (headText === undefined || headText === baseText) return undefined;
  const head = readContract(headText);
  if (!head.ok) return { loosened: [], unsound: head.problems };
  const base = baseText === undefined ? undefined : readContract(baseText);
  const more = loosened(
    base !== undefined && base.ok ? base.contract : undefined,
    head.contract,
  );
  return more.length === 0 ? undefined : { loosened: more };
}

/** One sentence per crossing, as the pull page and the ledger say it. */
export const wallSentence = (l: Loosened): string =>
  `${l.resource}.${l.verb} as ${l.as}: ${l.from === "absent" ? "new, and" : `was ${l.from}, now`} ${l.to}`;
