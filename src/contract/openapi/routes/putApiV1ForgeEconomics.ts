import type { Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: "/api/v1/forge/economics",
  summary: "Set the profit slider's position, the margin on crew spend and/or the label that selects owned nodes; a field left out keeps its value, each change is kept (a person admin's token, admin scope)",
  auth: true,
  body: { position: "whole number 0-100", marginPct: "whole number 0-500", ownedNodeLabel: "node label key=value, e.g. plat.sh/site=vxrail" },
  refusals: {
    not_found: "the token is not a person who administers the forge (404)",
    not_admin: "the person's role may not administer the forge (403)",
    bad_position: "position is not a whole number from 0 to 100 (422)",
    bad_margin: "marginPct is not a whole number from 0 to 500 (422)",
    bad_label: "ownedNodeLabel is not a node label as key=value (422)",
  },
};
