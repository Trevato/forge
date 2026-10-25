/**
 * What a forge admin's doors say when they refuse (#5561): one place, so
 * the API, MCP and the OpenAPI contract read the same sentence and cannot
 * drift when one door is edited.
 */

export const ADMIN_WORDS = {
  /** account_suspend / remove: the owner acting on themselves, an admin, or an agent. */
  selfSuspend: "an admin cannot suspend or remove themselves, another admin, or an agent",
  /** The crew scorecard, asked for by anyone but a forge admin. */
  scorecard: "the crew's scorecard is a forge admin's to read",
  /** Setting the front page's picks, asked for by anyone but a site admin. */
  frontPage: "the front page is a site admin's to set",
} as const;
