/**
 * The forge family's refusals: what a repository outside the fork tree's
 * rules is told, typed once so the API, MCP and the contract read the same
 * sentence from one place.
 */
export const FAMILY_WORDS = {
  /** Proposing to the parent forge with no commit ahead of it. */
  nothing_to_propose: "nothing here is ahead of the parent forge",
  /** Taking, severing or changing the mode of a repository with no chain across forges. */
  not_following: "this repository follows nothing across forges",
  /** Showing or hiding a migration trail on a repository that was never migrated. */
  no_provenance: "this repository was not migrated here",
} as const;
