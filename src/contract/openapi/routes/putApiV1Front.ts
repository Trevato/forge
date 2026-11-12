import { ADMIN_WORDS } from "../../../actions/admin_words.ts";
import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/front",
  summary: "Set the front page's picks (a site admin's, rw scope): `pinned` and `hidden` are arrays of owner/name, `weights` an object of forks, ships, use, fresh; answers the picks",
  auth: true,
  role: "admin",
  body: { pinned: "array", hidden: "array", weights: "object" },
  refusals: { invalid: "the picks are malformed or name no repository (422)", forbidden: `${ADMIN_WORDS.frontPage} (403)` },
};
