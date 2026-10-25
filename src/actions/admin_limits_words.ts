/**
 * The quota and usage sentences an admin reads (#5621): said once here and
 * read by the web pages and the terminal screens alike, so they cannot drift.
 */

/** A quota change was refused because a value was not a positive whole number. */
export const QUOTA_INVALID = "A quota is a positive whole number, or empty for no limit.";

/** Someone who is not a forge admin asked for the usage report. */
export const USAGE_ADMIN_ONLY = "Usage is read by a forge admin.";
