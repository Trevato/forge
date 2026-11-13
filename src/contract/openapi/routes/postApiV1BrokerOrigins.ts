import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/broker/origins",
  summary:
    "A child forge's signed ask to broker an origin sign-in (`op`: offers, device, redeem, refresh); only a child holding the heartbeat key this forge gave it may call it, signed in the signature header over the exact body, body at most 16 KiB; answers { ok } with the reason in `error` when false, and every unsigned or unknown caller gets the same 404 `not_found`",
  auth: false,
  role: "anonymous",
  refusals: { not_found: "the call is not signed by a child of this forge, or is stale" },
};
