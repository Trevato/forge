import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/pinned",
  summary: "The forge's pinned forges with each one's recorded changes, and the targets with what each can and cannot host; a forge administrator's",
  auth: true,
  refusals: {
    not_found: "only a forge administrator sees this route",
    refused: "the request was understood and refused; the message says why (422)",
  },
};
