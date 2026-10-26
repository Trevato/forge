/**
 * What the planner's refusals say, said from one place (#5595): a link or a
 * plan item that would make an issue wait for itself, and a limb whose
 * re-plan the planner already holds. The API, the MCP, the plan and the
 * terminal read these, so the words cannot drift between them.
 */

/** A link, or a plan item, that names its own issue as what it waits for. */
export const SELF_WAIT = "an issue cannot wait for itself";

/** A re-plan that can no longer be taken back: the planner has been given it. */
export const IN_HAND = "the planner has it in hand already";
