/**
 * The sentences every way of making an account says when a username is
 * malformed or an email is already held: the sign-up form, the passkey
 * sign-up, a claim, an everyday invite and the first-admin door. One place,
 * so they read the same wherever they are said.
 */

/** A username outside the safe-name alphabet. */
export const INVALID_USERNAME_MESSAGE = "Usernames are letters, digits, dots and dashes.";

/** An email that already belongs to an account. */
export const EMAIL_TAKEN_MESSAGE = "That email already has an account.";
