/**
 * What a new issue or pull says when its title or description is too long
 * (#5587): one place, read by the issue form and the pull form alike, so the
 * two never drift apart.
 */

/** A title past MAX_TITLE in src/core/issues.ts. */
export const TITLE_TOO_LONG = "That title is too long (256 characters at most).";

/** A description past the body limit. */
export const BODY_TOO_LONG = "That description is too long (64 KB at most).";
