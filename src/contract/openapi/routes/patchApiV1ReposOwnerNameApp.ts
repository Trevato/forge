import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: `${REPO}/app`,
  summary: "Change the app's settings (admin scope); `access` is public or private, `previewData` is copy or empty",
  auth: true,
  role: "member",
  body: { slug: "string", access: "string", previewData: "string" },
};
