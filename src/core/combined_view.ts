/**
 * What a fork's pull shows of its combined branch (#9012), the same on the
 * page and in the terminal: the branch and commit the preview builds, the
 * base it was built on and whether main has moved since, what each conflict
 * kept, and that the checks ran on the head, not on this commit.
 */

import type { Pull } from "./pulls.ts";
import { keptLine, readCombined, TAKE_BACK, type Kept } from "../git/combined.ts";

export interface CombinedView {
  readonly branch: string;
  readonly oid: string;
  /** The main commit this combining was built on; "" when its note does not say. */
  readonly builtOn: string;
  /** Main has moved past `builtOn`: the preview is not what lands until it recombines. */
  readonly stale: boolean;
  readonly files: readonly Kept[];
}

/** The combined branch of an open fork's pull, when it differs from the head. */
export async function combinedView(
  dir: string,
  pull: Pull,
  headOid: string,
  baseOid: string,
): Promise<CombinedView | undefined> {
  if (!pull.crossRepo || pull.state !== "open" || pull.mergedAt !== null) return undefined;
  const read = await readCombined(dir, pull.number, headOid);
  // Main already in the head: the preview is the head itself, nothing to say.
  if (read === undefined || read.oid === headOid) return undefined;
  return {
    branch: read.branch,
    oid: read.oid,
    builtOn: read.baseOid,
    stale: read.baseOid !== "" && read.baseOid !== baseOid,
    files: read.files,
  };
}

/** The view, worded: the lead, the per-file lines, and the notes after them. */
export function combinedWords(
  view: CombinedView,
  number: number,
): { lead: string; files: string[]; notes: string[] } {
  const notes: string[] = [];
  if (view.stale)
    notes.push(
      `Stale: main has moved since ${view.builtOn.slice(0, 10)}, which this was built on. It recombines on the next push to the fork, and merging recombines before it lands, so what lands may differ from the preview.`,
    );
  notes.push("Checks run on the pull's head, not on this combined commit.");
  if (view.files.some((f) => f.kept === "main")) notes.push(TAKE_BACK);
  return {
    lead: `The preview is built from ${view.branch} (${view.oid.slice(0, 10)}): main merged into this pull's head. Merging lands that branch.`,
    files: view.files.map((f) => keptLine(f, number)),
    notes,
  };
}
