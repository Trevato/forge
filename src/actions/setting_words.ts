/**
 * The refusals a setting's door answers (#5563): a capacity value out of
 * range, and an app's people set by someone who does not write the
 * repository. The API and the MCP tools read them from here, so one door
 * cannot reword them without the other. Plain data.
 */

export const SETTING_WORDS = {
  /** A capacity value the setting does not take. */
  outOfRange: "that value is outside what this setting takes",
  /** An app's members changed or read by an agent or a non-writer. */
  appMembersForbidden: "the people an app names are its writers' to choose",
} as const;
