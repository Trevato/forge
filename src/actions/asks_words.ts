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

/** Undoing a bulk operation that was undone before. */
export const ALREADY_UNDONE = "this operation was undone already";

/** The fleet verbs a bulk action on asks takes, as a person reads them. */
export const VERB_WORDS: Readonly<Record<string, string>> = {
  dismiss: "Dismiss",
  decline: "Decline",
  mute: "Mute repository",
  ship: "Ship",
  close: "Close",
  replan: "Hand back to the planner",
};

/**
 * The receipt of a bulk action on asks in one sentence: "Dismiss: 3 done",
 * or "Dismiss undone: 3" for its undo. The page, the terminal and MCP say
 * exactly this.
 */
export function receiptSentence(verb: string, done: number, undo: boolean): string {
  const word = Object.hasOwn(VERB_WORDS, verb) ? VERB_WORDS[verb]! : verb;
  return undo ? `${word} undone: ${done}` : `${word}: ${done} done`;
}
