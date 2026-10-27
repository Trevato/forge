/**
 * What a take-back refusal says (#7211): one place, so the studio's
 * "take it back" button, the MCP `take_back` tool and the terminal's
 * pull screen (#7228) read the same.
 */

import type { RevertPullError } from "./revert.ts";

/** A take-back refusal in the studio's words. */
export function takeBackWords(error: RevertPullError): string {
  if (typeof error === "string") {
    switch (error) {
      case "not_shipped":
        return "it has not shipped";
      case "mirrored":
        return "the origin owns this history";
      case "already_reverted":
        return "it has already been taken back";
      case "unauthorized":
        return "sign in first";
      case "forbidden":
        return "only a person can take a pull request back";
      case "not_found":
        return "that pull request was not found";
    }
  }
  switch (error.kind) {
    case "conflict":
      return `it conflicts with the current code in ${error.files.join(", ")}`;
    case "unsafe":
      return "git refused it";
    case "base_moved":
      return "the base moved under it";
    case "git":
      return `git said ${error.message}`;
    case "octopus":
      return "it has more than two parents";
    case "branch_failed":
      return `it could not be made ready (${error.reason})`;
    case "pull_failed":
      return `the change could not be opened (${error.reason})`;
  }
}
