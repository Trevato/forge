import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/passport/health",
  summary:
    "The forge's public health, for a caller holding a passport (`Authorization: Passport <token>`, audience `forge`, scope `health:read`) rather than a token; answers the same body as the anonymous health, uncached",
  auth: false,
  role: "anonymous",
  refusals: { unauthorized: "the passport is missing, malformed, expired, or not for this audience and scope (always 401)" },
};
