import { BROWSE, BROWSE_REFUSALS, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: BROWSE,
  summary: "Read a repository's landing live from the origin (the connecting user only); answers { ...where, capabilities, facts, branches, readme }, with branches [] and readme null when the origin could not give them",
  auth: true,
  refusals: BROWSE_REFUSALS,
};
