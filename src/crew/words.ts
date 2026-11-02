/**
 * Why a run waits for a builder, said once (#5652). The finishing pass
 * (`finishing.ts`) and the changes-requested pass (`requested.ts`) both
 * report these as a pull's `why`, and every door — page, API, MCP,
 * terminal — reads them from there, so they read the same everywhere.
 */

/** Every builder slot this tick is spent: the pull moves on a later one. */
export const WAITS_FOR_BUILDER_SLOT = "waits for a builder slot";

/** The repository's crew has no agent in the builder role to run it. */
export const NO_BUILDER_ON_CREW = "no builder on the crew";
