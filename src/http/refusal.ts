/**
 * What a database guard's refusal may say to the caller (#723). A trigger's
 * `RAISE(ABORT, '…')` message is answered to anyone, anonymous callers
 * included, so only a message that opts in is shown: it starts with
 * `forge: ` and is written for anyone. Any other message is answered with a
 * generic text and logged in full for the operator.
 */

/** The prefix a guard puts on a message that is meant for the person refused. */
export const REFUSAL_PREFIX = "forge: ";

/** What a caller is told when a guard's message did not opt in. */
export const GENERIC_REFUSAL = "refused";

/**
 * The messages this repository's own triggers (migrations 62, 70, 81) raised
 * before the prefix existed. A migration is never rewritten once it has run,
 * so these stay as written and are known by name.
 */
const BUILT_IN = new Set([
  "only an agent can be on a crew",
  "a sealed repository is never public",
  "a thought is never changed",
  "a thought is never deleted",
]);

/** The words to show for a guard's message: its own, or the generic text. */
export function shownRefusal(message: string): string {
  return message.startsWith(REFUSAL_PREFIX) || BUILT_IN.has(message)
    ? message
    : GENERIC_REFUSAL;
}

/**
 * The original message of a refusal a database trigger raised
 * (`RAISE(ABORT, '…')`), or undefined for any other error.
 */
export function refusedByDatabase(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_CONSTRAINT_TRIGGER" ? error.message : undefined;
}

/**
 * The words to show for a thrown error if a database trigger refused, else
 * undefined: the one door both the page and the terminal answer through.
 */
export function refusalText(error: unknown): string | undefined {
  const refused = refusedByDatabase(error);
  return refused === undefined ? undefined : shownRefusal(refused);
}
