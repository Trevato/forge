/**
 * The words an outsider reads back after filing a report. Every door — the
 * API's POST …/reports and the MCP `report` tool — answers from here, so
 * the sentence reads the same wherever the report came in.
 */

/** The answer to a report that was filed and now waits for a person. */
export const REPORT_RECEIVED =
  "Received. A person who maintains this repository will read it; nothing acts on it before they do.";
