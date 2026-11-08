/**
 * A run that finds its issue already done. When a builder declines because
 * the work is on the base branch already, and names the commit that did it,
 * the run ends as `already done: <oid> …` — its own outcome, not a park and
 * no strike (`settleAgentRun`). Only the runner writes that summary, and
 * only after every commit it names is on the base (`onBase`): a run that
 * says "already done" with nothing to show for it is an ordinary decline,
 * and is parked as one. The close is left to the person who asked.
 */

import { DONE_NOTE } from "../core/done_on_main.ts";
import { runGit } from "../git/env.ts";

/** What a verified run's summary starts with, before the full commit ids. */
export const ALREADY_DONE = "already done: ";

/** What the note on the issue starts with, before the commit ids. */
export const ALREADY_NOTE = DONE_NOTE;

/** The most commits one verdict names. */
const MOST = 5;

const OID = /\b[0-9a-f]{7,40}\b/g;

/**
 * The commits a decline names, when it says the work is already done:
 * the words "already" and "done"/"built"/"shipped"/"on main"/"landed" and
 * at least one hex id. Anything else names none.
 */
export function namedCommits(reason: string): string[] {
  if (!/\balready\b/i.test(reason)) return [];
  if (!/\b(done|built|shipped|landed|merged|implemented|on (main|the base))\b/i.test(reason))
    return [];
  return [...new Set(reason.toLowerCase().match(OID) ?? [])].slice(0, MOST);
}

/**
 * The full ids, of those named, that are commits reachable from `branch`
 * in the bare repository at `dir`; an id that is not there, or is an
 * abbreviation of more than one object, is dropped.
 */
export async function onBase(
  dir: string,
  branch: string,
  named: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const short of named) {
    if (!/^[0-9a-f]{7,40}$/.test(short)) continue;
    const full = await runGit(
      ["rev-parse", "--verify", "--quiet", `${short}^{commit}`],
      { cwd: dir },
    );
    if (!full.ok || !/^[0-9a-f]{40}$/.test(full.value)) continue;
    const reaches = await runGit(
      ["merge-base", "--is-ancestor", full.value, `refs/heads/${branch}`],
      { cwd: dir },
    );
    if (reaches.ok && !found.includes(full.value)) found.push(full.value);
  }
  return found;
}

/** The summary of a run whose issue is done on the base by these commits. */
export const alreadyDoneSummary = (oids: readonly string[]): string =>
  `${ALREADY_DONE}${oids.join(" ")}`;

/** The commits a run's summary names, when it is an already-done outcome. */
export function alreadyDoneOids(summary: string): string[] {
  if (!summary.startsWith(ALREADY_DONE)) return [];
  return summary
    .slice(ALREADY_DONE.length)
    .split(" ")
    .filter((o) => /^[0-9a-f]{40}$/.test(o))
    .slice(0, MOST);
}

/** What a builder's final words decline with, when they begin `DECLINED`. */
export function declineOf(text: string): string | undefined {
  return /^\s*DECLINED\b/i.test(text)
    ? text.replace(/^\s*DECLINED:?\s*/i, "").trim()
    : undefined;
}

/**
 * Whether a run stopped from outside still has its own answer worth keeping:
 * an already-done decline it reached before its pull closed under it. A run
 * the meter stopped (`stoppedFor`) has none: the cap is the reason it ended.
 */
export const answeredBeforeStop = (
  stoppedFor: string | undefined,
  text: string,
): boolean =>
  stoppedFor === undefined && namedCommits(declineOf(text) ?? "").length > 0;

/** Whether a run's summary is the already-done answer. */
export const isAnswer = (summary: string): boolean =>
  summary.startsWith(ALREADY_DONE);
