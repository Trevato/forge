/**
 * Follow words (#7199): what each follow mode does, in one plain line, so
 * `/forges/new`, the terminal's new-forge screen and MCP `spawn` say the
 * same thing. They describe `src/spawn/upstream.ts`: `tell-me` sends the
 * owner an inbox card when this forge's code moves; `take-updates` opens the
 * one `forge/take-updates` pull (`src/spawn/take.ts`), which a person merges.
 */

import type { FollowMode } from "./chain.ts";

export const FOLLOW_LABELS: Readonly<Record<FollowMode, string>> = {
  "tell-me": "Tell me",
  "take-updates": "Take updates",
};

export const FOLLOW_WORDS: Readonly<Record<FollowMode, string>> = {
  "tell-me": "tells the owner in their inbox when this forge's code moves.",
  "take-updates": "opens a pull with the new code, and a person merges it.",
};

/** One line naming both modes, for the terminal's hint. */
export const FOLLOW_LINE =
  `tell-me (default) ${FOLLOW_WORDS["tell-me"]} take-updates ${FOLLOW_WORDS["take-updates"]}`;

/** The same, short enough for an MCP field (60 bytes); docs/MCP.md has the long words. */
export const FOLLOW_SHORT = "tell-me: an inbox card; take-updates: a pull a person merges";
