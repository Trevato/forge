/**
 * The sentences a passkey ceremony says when it fails, written once for
 * anyone: Settings → Passkeys and sign-in (`pages/passkeys.ts`), sign-up
 * (`pages/signup-passkey.ts`) and the account-making forms
 * (`passkey-ceremony.ts`) all read them from here, so they cannot drift.
 */

/** The challenge was spent, unknown, or too old. */
export const PASSKEY_EXPIRED = "That request expired. Try again.";

/** The browser's answer did not verify. */
export const PASSKEY_REJECTED = "That passkey was not accepted.";

/** Another account (or this one) already holds the key. */
export const PASSKEY_TAKEN = "That passkey is already registered.";
