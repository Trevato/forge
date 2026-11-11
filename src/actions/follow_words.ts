import { FORK_FOLLOW_MODES, type ForkFollowMode } from "../core/fork_follow.ts";

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

/** The words of a button that switches a fork to `mode`. */
export const FOLLOW_SWITCH_LABELS: Record<ForkFollowMode, string> = {
  "take-updates": "Follow automatically",
  "tell-me": "Only propose updates",
  "dont-follow": "Stop following",
};

/** How a fork follows its upstream, in one line and the reason beside it: the page and the MCP say these words. */
export function followModeWords(
  mode: ForkFollowMode,
  upstream: string,
): { readonly line: string; readonly reason: string; readonly others: readonly ForkFollowMode[] } {
  const others = FORK_FOLLOW_MODES.filter((m) => m !== mode);
  if (mode === "take-updates")
    return {
      line: `Follows ${upstream} automatically`,
      reason: `New code from ${upstream} is merged in as it lands; a conflict goes to the crew.`,
      others,
    };
  if (mode === "dont-follow")
    return {
      line: `Does not follow ${upstream}`,
      reason: `Nothing from ${upstream} is merged or announced here; it can still offer its changes up.`,
      others,
    };
  return {
    line: `Proposes updates from ${upstream}`,
    reason: `You are told when ${upstream} has something new and take it when you choose.`,
    others,
  };
}

/** What switching to `mode` changes, for the confirm step. */
export function followSwitchPreview(mode: ForkFollowMode, upstream: string): string {
  if (mode === "take-updates")
    return `From now on new code from ${upstream} is merged into this fork as it lands, without asking. When both sides changed the same files, nothing is merged and the crew is told to converge them. You can switch back at any time.`;
  if (mode === "dont-follow")
    return `From now on this fork goes its own way: nothing from ${upstream} is merged or announced here, and the crew is never asked to converge. You can still offer your changes up, and follow again at any time.`;
  return `From now on ${upstream} only proposes: you are told when it has something new and nothing is merged until you take it. You can switch back at any time.`;
}

/** An instant as people say it: "just now", "2 days ago". Said by the page and the MCP alike. */
export function agoWords(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"} ago`;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return unit(Math.floor(seconds / 3600), "hour");
  if (seconds < 86_400 * 30) return unit(Math.floor(seconds / 86_400), "day");
  if (seconds < 86_400 * 365) return unit(Math.floor(seconds / (86_400 * 30)), "month");
  return unit(Math.floor(seconds / (86_400 * 365)), "year");
}

/** The words that name a fork's choice, by mode, before the upstream. */
const STANDING_LEADS: Record<ForkFollowMode, string> = {
  "take-updates": "Takes updates from",
  "tell-me": "Sends offers to",
  "dont-follow": "Not following",
};

/**
 * The one plain line a fork's page and the MCP say: its choice, the upstream
 * (`upstream` is undefined when the reader may not read it, so it is not named)
 * and, when it ever took from it, when it last did.
 */
export function followStandingLine(
  mode: ForkFollowMode,
  upstream: string | undefined,
  tookAt: string | null,
  now: number = Date.now(),
): string {
  const line = `${STANDING_LEADS[mode]} ${upstream ?? "its upstream"}`;
  return tookAt === null ? line : `${line} · last took ${agoWords(tookAt, now)}`;
}
