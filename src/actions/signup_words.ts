/**
 * The sentences a person reads when the name or email they chose for a new
 * account or org will not do. Every door that makes one (the sign-up and
 * claim pages, an everyday invite, the first admin, the crew and org forms,
 * passkey sign-up) says them from here, so they read the same everywhere.
 */

/** A username outside the safe-name alphabet. */
export const INVALID_USERNAME_MESSAGE = "Usernames are letters, digits, dots and dashes.";

/** An email that already belongs to an account. */
export const EMAIL_TAKEN_MESSAGE = "That email already has an account.";

export const USERNAME_TAKEN = "That username is taken.";
export const NAME_RESERVED = "That name is reserved.";
export const EMAIL_WANTED = "An email address, please.";
