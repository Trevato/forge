/**
 * The refusals an origin, an app and a report share across every door: the
 * API's error body and the MCP tool's answer say each from here, so the
 * wording is one edit away from changing everywhere (#5647).
 */

/** An origin (a git host to mirror from) answered nothing usable. */
export const ORIGIN_UNREACHABLE = "the origin could not be reached";

/** Making an app yours when it already is. */
export const APP_ALREADY_YOURS = "this app is already yours";

/** Deciding a report that was already decided. */
export const REPORT_ALREADY_DECIDED = "this report was already decided";
