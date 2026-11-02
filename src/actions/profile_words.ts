/**
 * What a person is told when `updateProfile` refuses: one sentence per error,
 * shared by Settings › Account and the terminal's profile screen so the two
 * say the same thing.
 */

import type { updateProfile } from "./users.ts";

type ProfileError = Extract<ReturnType<typeof updateProfile>, { ok: false }>["error"];

/** The refusals a person can fix by writing something else. */
export const PROFILE_REFUSALS: Partial<Record<ProfileError, string>> = {
  email_taken: "Another account already uses that address.",
  invalid_email: "That doesn't look like an email address.",
  display_name_reserved: "That name belongs to the crew, the owner or the forge.",
  display_name_mixed_script:
    "Write it in one alphabet: letters from different scripts can pass for other names.",
};

/** The form field a refusal belongs to. */
export const PROFILE_REFUSAL_FIELD: Partial<Record<ProfileError, "displayName" | "email">> = {
  email_taken: "email",
  invalid_email: "email",
  display_name_reserved: "displayName",
  display_name_mixed_script: "displayName",
};

/** Any refusal not named above (a failed sign-in, a vanished account): nothing the person typed is at fault. */
export const PROFILE_FALLBACK = "Your profile could not be saved. Sign in again and try once more.";

/** After a new address is saved: the link goes to it, and the old proof no longer stands. */
export const emailSavedWords = (email: string): string =>
  `Email saved. A confirmation link was sent to ${email}; it is not verified until you follow it.`;
