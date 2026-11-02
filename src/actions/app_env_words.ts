/**
 * The words a person reads about an app's variables: where a scope sends
 * one, and why `setAppEnvVar` or `deleteAppEnvVar` refused. The settings
 * page and the terminal both say them, so they are said from here.
 */

import { NAME_MAX, type AppEnvScope } from "../core/app_env.ts";

/** Where a variable in a scope goes. */
export const SCOPE_WORDS: Record<AppEnvScope, string> = {
  all: "everywhere",
  production: "production",
  preview: "previews",
};

/** `setAppEnvVar`'s refusals, by code. */
export const APP_ENV_ERRORS: Record<string, string> = {
  invalid_name: `A name is capital letters, digits and underscores, starting with a letter — ADMIN_PASSWORD, STRIPE_SECRET_KEY — and at most ${NAME_MAX} characters.`,
  reserved_name:
    "That name is the forge's own (PORT, HOST, PATH, FORGE_…); the app is already told it.",
  invalid_value: "A value is one line or many, never empty and under 64 KiB.",
  invalid_scope: "A variable goes everywhere, to production, or to previews.",
};

/** `setAppEnvVar` refused with a code the table does not name. */
export const APP_ENV_NOT_SET = "That variable could not be set.";

/** `deleteAppEnvVar` refused as `no_such_var`. */
export const APP_ENV_NO_SUCH = "No variable by that name.";
