/**
 * A person's pull from a branch of the repository itself (#7572): the
 * owner's or a steward's fix, opened by hand or with an admin token. It is
 * a normal pull — a push to its branch moves its head (`trackPullHead`) and
 * runs its check, review and gate again, and green it lands through the
 * queue — but no agent can push its branch: the crew works from forks.
 *
 * So the crew never sends a builder to it and never parks it. Changes asked
 * for on it go back to its author (`requested.ts`), and closing it is only
 * theirs: a closed pull no longer follows its branch, and every later push
 * would be lost to it.
 */

import type { Pull } from "../core/pulls.ts";

/** Whether the pull is a person's, from a branch of the repository it proposes to. */
export function authorsInRepoPull(pull: Pick<Pull, "authorIsAgent" | "crossRepo">): boolean {
  return !pull.authorIsAgent && !pull.crossRepo;
}

/** What the changes-requested pass says of one, once it is back with its author. */
export const BACK_WITH_AUTHOR = "back with its author, a person: the branch lives in the repository";
