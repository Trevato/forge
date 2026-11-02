/**
 * A branch's sentences (#5713): making or deleting a branch reads the same
 * from the branches page, the MCP and the terminal, so each is
 * typed once and read from here.
 */

/** A branch create refused for a reason with no sentence of its own. */
export const BRANCH_NOT_CREATED = "That branch was not created.";

/** A branch delete refused for a reason with no sentence of its own. */
export const BRANCH_NOT_DELETED = "That branch was not deleted.";

/** The terminal's answer to a branch name left empty. */
export const NAME_THE_BRANCH = "give the branch a name";
