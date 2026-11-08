/**
 * What a refusal says at the repositories limit, or when it names an agent
 * that is not here (#5720): one place, read by migrate, repos, the apps page,
 * the fleet, the terminal and the MCP, so every door says it the same way.
 */

/** The fallback when an account is at its repositories limit. */
export const AT_REPOSITORY_LIMIT = "at the repositories limit";

/** An agent named that has no account on this forge. */
export const NO_SUCH_AGENT = "That agent is not on this forge.";

/** An agent named that is not on the repository's crew. */
export const AGENT_NOT_ON_CREW = "that agent is not on this repository's crew";
