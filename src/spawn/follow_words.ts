/**
 * Follow words (#7199): what each follow mode does, in one plain line, so
 * `/forges/new`, the terminal's new-forge screen and MCP `spawn` say the
 * same thing. They describe `src/spawn/upstream.ts`: `tell-me` sends the
 * owner an inbox card when this forge's code moves; `take-updates` (the
 * default) fast-forwards a forge the owner has not changed, and otherwise
 * opens the one `forge/take-updates` pull (`src/spawn/take.ts`), which a person merges.
 */

import type { FollowMode } from "./chain.ts";

export const FOLLOW_LABELS: Readonly<Record<FollowMode, string>> = {
  "tell-me": "Tell me",
  "take-updates": "Take updates",
};

export const FOLLOW_WORDS: Readonly<Record<FollowMode, string>> = {
  "tell-me": "tells the owner in their inbox when this forge's code moves.",
  "take-updates": "takes new code in by itself; opens a pull once the repository has commits of its own.",
};

/** One line naming both modes, for the terminal's hint. */
export const FOLLOW_LINE =
  `take-updates (default) ${FOLLOW_WORDS["take-updates"]} tell-me ${FOLLOW_WORDS["tell-me"]}`;

/** The same, short enough for an MCP field (60 bytes); docs/MCP.md has the long words. */
export const FOLLOW_SHORT = "take-updates: merges itself or a pull; tell-me: inbox card";
