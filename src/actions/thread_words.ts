/**
 * The refusals a thread gives when someone changes its labels or plans it,
 * written once so the page and the MCP tools say them the same way.
 */
export const THREAD_SAYS = {
  labelsForbidden: "You need write access to change labels.",
  unknownLabel: "One of those labels no longer exists.",
  planForbidden: "You need write access, or a place on the crew, to plan here.",
} as const;
