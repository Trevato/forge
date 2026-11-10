import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/following/take`,
  summary:
    "Take the parent's updates: a fork merges (the same answer as sync); the repository carrying this forge's code takes as a pull",
  auth: true,
  role: "member",
  refusals: {
    not_a_fork: "404: this repository follows nothing",
    not_following: `404: ${FAMILY_WORDS.not_following}`,
    conflict: "409: both sides changed these files; the crew was told; { files, converge, issue }",
    moved: "409: something moved while this was read; try again",
  },
};
