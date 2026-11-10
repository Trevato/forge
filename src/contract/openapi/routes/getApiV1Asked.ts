import type { Route } from "../shared.ts";
import { ORDER_WORDS } from "../../../core/arg_words.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/asked",
  summary: "What people asked, and the caller's thought stream; answers { asked, thoughts } (ro scope)",
  auth: true,
  role: "member",
  query: { show: "string", order: "string", repo: "string" },
  refusals: { invalid_show: "show is all, unshipped or flagged", invalid_order: ORDER_WORDS },
};
