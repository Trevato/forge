/**
 * The refusals a board save, a vote and a milestone watch answer with
 * (#5645): one sentence each, said the same by the API and the MCP because
 * both read it from here. Plain strings, no imports.
 */

/** A board write refused for a reason its error code names. */
export const BOARD_NOT_SAVED = "that board could not be saved";

/** A vote refused for a reason its error code names. */
export const VOTE_NOT_RECORDED = "that vote could not be recorded";

/** An agent asked to watch a milestone; watching is a person's. */
export const MILESTONE_WATCH_PERSON_ONLY = "only a person watches a milestone";
