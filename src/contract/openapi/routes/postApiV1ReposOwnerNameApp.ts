import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/app`,
  summary: "Turn the repository into an app (admin scope); `access` is public or private, `previewData` is copy or empty; answers 201 with the app",
  auth: true,
  role: "member",
  body: { slug: "string", access: "string", previewData: "string" },
  status: 201,
  refusals: { app_limit: "the owner is at the app limit" },
};
