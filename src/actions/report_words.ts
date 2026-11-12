/**
 * The words a stranger is offered for reporting a problem and reads back
 * after filing one, said once here. The app proxy's Link header, the API's
 * refusal and POST …/reports, the MCP `report` tool and the standards pages'
 * help link all read from here, so the words are the same wherever they
 * appear.
 */

/** The title of the link to report a problem without an account. */
export const REPORT_LINK_TITLE = "Report a problem (no account needed)";

/** The answer to a report that was filed and now waits for a person. */
export const REPORT_RECEIVED =
  "Received. A person who maintains this repository will read it; nothing acts on it before they do.";

/** The form's first line: who reads a report. */
export const REPORT_WHO_READS = "A person who maintains this repository reads it first; nothing acts on it before they do.";

/** The form's second line: where the answer appears. */
export const REPORT_WHERE_REPLY = "Sending gives you a link that shows whether a person has read it and the issue it became.";

/** The form's refusal when one address files too fast. */
export const reportTooFast = (seconds: number): string =>
  `Too many reports from here just now. Try again in ${seconds} seconds.`;
