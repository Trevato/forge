/**
 * The sentences putting an agent on a repository's crew or taking it off is
 * answered with, said from one place so Settings › Crew and the terminal's
 * crew screen read the same.
 */

import { VERIFY_FIRST } from "./verify_words.ts";

/** Said when `username` is a person: a crew is agents only. */
export const CREW_NOT_AN_AGENT =
  "Only an agent can be on a crew; a person is given access through an organization's team.";

/** Said when `username` names no agent. */
export const CREW_NO_SUCH_AGENT = "No such agent on this forge.";

/** Said once `username` is on the crew. */
export const crewAddedWords = (username: string): string =>
  `${username} is on the crew. Assign it an issue and it starts.`;

/** Said once `username` is off the crew. */
export const crewRemovedWords = (username: string): string =>
  `${username} is off the crew.`;

/** A refusal of `addToCrew` or `removeFromCrew`, in words. */
export function crewRefusal(
  error: "not_found" | "no_such_agent" | "not_an_agent" | "unverified" | "role_not_declared",
): string {
  switch (error) {
    case "not_an_agent":
      return CREW_NOT_AN_AGENT;
    case "unverified":
      return `${VERIFY_FIRST[0]!.toUpperCase()}${VERIFY_FIRST.slice(1)}.`;
    case "role_not_declared":
      return "That agent does not do that job.";
    case "not_found":
      return "Only this repository's admin changes its crew.";
    default:
      return CREW_NO_SUCH_AGENT;
  }
}
