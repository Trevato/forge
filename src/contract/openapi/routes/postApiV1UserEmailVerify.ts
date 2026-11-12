import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/user/email/verify",
  summary: "Send the caller another email verification link: {outcome} is sent (202) or already (200, nothing sent)",
  auth: true,
  role: "member",
  status: 202,
  refusals: {
    unauthorized: "401: no signed-in account",
    too_soon: "429: a link was sent a moment ago",
    capped: "429: the forge's mail cap is reached",
    no_mail: "503: this forge sends no mail",
    failed: "502: the link could not be sent",
  },
};
