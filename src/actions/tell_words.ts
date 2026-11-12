/**
 * What a tell or a report says when it is empty or does not go (#5650):
 * one place, so the studio's box, the toolbar's report, the run page and
 * the terminal read the same. Plain strings, no imports.
 */

/** A tell that failed for a reason nobody can be told about. */
export const NOT_TOLD_WORDS = "That could not be told.";

/** A tell from a page whose context could not be read. */
export const NOT_TOLD_FROM_WORDS = "That page could not be told from.";

/** A tell, reply or report sent with nothing in it. */
export const SAY_SOMETHING_WORDS = "Say something first.";

/** A report that did not reach the issue list. */
export const NOT_SENT_WORDS = "That could not be sent.";

/** A first ask whose app would be the forge's own repository. */
export const FORGE_REPO_WORDS = "That name is this forge's own repository. Ask again in other words and it makes a new app.";
