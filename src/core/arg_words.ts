/**
 * What a caller is told when an argument is outside its allowed values
 * (#5644). The API, the feed and MCP refuse the same argument with the same
 * sentence, so each is written here once and read by every door.
 */

/** An answer to a pull: `like` or `dislike`. */
export const ANSWER_WORDS = "answer is like or dislike";

/** Whether an upstream is followed: `enabled`, a boolean. */
export const ENABLED_WORDS = "enabled is true or false";

/** Whether a feed chip is hidden: a boolean. */
export const HIDDEN_WORDS = "hidden is true or false";

/** A board pin's `op`: `pin`, `unpin` or `move`. */
export const PIN_OP_WORDS = "op must be pin, unpin or move";

/** A listing's `order`: `oldest` or `newest`. */
export const ORDER_WORDS = "order is oldest or newest";

/** The forge's `signup` setting: `open`, `invite` or `closed`. */
export const SIGNUP_WORDS = "signup is open, invite or closed";

/** A repository's `visibility`: `public` or `private`. */
export const VISIBILITY_WORDS = "visibility is public or private";
