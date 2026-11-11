import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/forge/following",
  summary: "Choose how this forge follows the forge its code came from (its code repository's admin); answers { mode }",
  auth: true,
  role: "member",
  body: { mode: "string" },
  refusals: {
    not_following: `404: ${FAMILY_WORDS.not_following}`,
    forbidden: "403: only this forge's owner can change how it follows",
    invalid_mode: "422: mode is not one the forge knows",
    severed: "409: this forge is severed and follows nothing",
  },
};
