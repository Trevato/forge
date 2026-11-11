import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/following/propose-parent`,
  summary: "Across forges: push this forge's change to the parent forge and open the pull there; answers 201 when opened, 200 when one stands",
  auth: true,
  role: "member",
  refusals: {
    no_parent_forge: "404: this repository has no parent forge to propose to",
    nothing_to_propose: `409: ${FAMILY_WORDS.nothing_to_propose}`,
    parent_unreachable: "502: the parent forge did not answer",
    refused: "409: the parent forge refused, with the reason",
  },
};
