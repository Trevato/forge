import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/vision`,
  summary:
    "A repository's vision from docs/VISION.md on the default branch, as MCP vision answers it: { purpose, order: [{ n, name, text }], rules, direction, directionStall, directionParts, preview, updatedAt }; without the document purpose is null and order empty; direction and directionParts only for those who may read the repository's settings, directionStall only for admins, else null; number (an open vision pull) adds preview { today, after } or { why } for those same people; a private repository needs a token",
  auth: false,
  query: { number: "integer" },
  refusals: {
    invalid_number: "number is not a whole number of 1 or more (422)",
  },
};
