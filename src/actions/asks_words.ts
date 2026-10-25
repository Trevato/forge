/**
 * What acting on asks says, said from one place (#5614): bulk decide,
 * decide and proposals read it here, and an ask or a bulk operation whose
 * subject is gone answers from here too, so the web, the API, MCP and the
 * terminal word it the same.
 */

/** Acting on an ask while signed out. */
export const SIGN_IN_TO_ACT = "sign in to act on your asks";

/** Deciding an ask that has moved on: it no longer waits on this person. */
export const NO_LONGER_ASKS = "it no longer asks you";

/** A bulk operation, or a fleet verb, this place does not know. */
export const NO_SUCH_OPERATION = "no such operation here";

/** A milestone that is not here, or not readable by the one asking. */
export const NO_SUCH_MILESTONE = "no such milestone here";
