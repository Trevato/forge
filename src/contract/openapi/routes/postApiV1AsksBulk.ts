import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/asks/bulk",
  summary:
    "One action on many asks. The default is a preview: unless `preview` is false it answers 200 { preview: true, ... } with what would happen to each ask and changes nothing (ro scope). With `preview` false it acts (rw scope) and answers 201 { preview: false, ... } with a receipt naming an operation, to undo at /api/v1/asks/bulk/{id}/undo. `action` is dismiss, decline, mute, ship, close or replan; only close takes a `reason`; `items` is up to 100 ask ids",
  auth: true,
  role: "member",
  status: 201,
  alsoStatus: [200],
  body: { action: "string", items: "array", reason: "string", preview: "boolean" },
  refusals: {
    bad_action: "`action` is unknown, `items` is not a list of ask ids, or `reason` is not a sentence or not for this action (422)",
    too_many: "more than 100 asks at once (429)",
  },
};
