import type { FollowMode } from "../spawn/chain.ts";

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

/** How a fork follows its upstream, in one line and the reason beside it: the page and the MCP say these words. */
export function followModeWords(
  mode: FollowMode,
  upstream: string,
): { readonly line: string; readonly reason: string; readonly other: FollowMode } {
  return mode === "take-updates"
    ? {
        line: `Follows ${upstream} automatically`,
        reason: `New code from ${upstream} is merged in as it lands; a conflict goes to the crew.`,
        other: "tell-me",
      }
    : {
        line: `Proposes updates from ${upstream}`,
        reason: `You are told when ${upstream} has something new and take it when you choose.`,
        other: "take-updates",
      };
}

/** What switching to `mode` changes, for the confirm step. */
export function followSwitchPreview(mode: FollowMode, upstream: string): string {
  return mode === "take-updates"
    ? `From now on new code from ${upstream} is merged into this fork as it lands, without asking. When both sides changed the same files, nothing is merged and the crew is told to converge them. You can switch back at any time.`
    : `From now on ${upstream} only proposes: you are told when it has something new and nothing is merged until you take it. You can switch back at any time.`;
}
