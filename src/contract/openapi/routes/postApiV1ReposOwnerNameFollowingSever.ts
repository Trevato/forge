import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/following/sever`,
  summary: "Stop following: a forge's link to its parent's code, or an app's link to the repository it came from, and any credential held for it; deletes nothing; answers { severedAt }",
  auth: true,
  role: "member",
  refusals: { not_following: `404: ${FAMILY_WORDS.not_following}` },
};
