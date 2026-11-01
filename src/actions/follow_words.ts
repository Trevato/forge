/**
 * Following's refusals in words (#5589): said by the chain page and the
 * following page alike, so they are typed once and read from here.
 */

/** A repository with no parent to follow, read, take from or sever. */
export const FOLLOWS_NOTHING = "This repository follows nothing.";

/** A reader asking to propose upstream without write access here. */
export const PROPOSE_NEEDS_WRITE = "You need write access to propose from here.";

/**
 * Why a proposal upstream was not made, in words: the following page and the
 * terminal's forks screen both say it from here. Any refusal that is only a
 * word is an access refusal; one with a reason is the parent's own.
 */
export function proposeRefusalWords(
  e: "not_a_fork" | "nothing_to_propose" | string | { readonly reason: string },
  parentName: string,
): string {
  if (e === "not_a_fork") return FOLLOWS_NOTHING;
  if (e === "nothing_to_propose") return `Nothing here is ahead of ${parentName}.`;
  if (typeof e === "string") return PROPOSE_NEEDS_WRITE;
  return `${parentName} did not take the proposal: ${e.reason}.`;
}
