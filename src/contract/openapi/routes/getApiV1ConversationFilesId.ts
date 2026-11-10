import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/conversation/files/{id}",
  summary: "Download one of the signed-in person's own attachments: always as an attachment with a fixed type (an image type or text/plain) and nosniff; another person's is not_found",
  auth: true,
  role: "member",
  refusals: { not_found: "no such attachment (404)" },
};
