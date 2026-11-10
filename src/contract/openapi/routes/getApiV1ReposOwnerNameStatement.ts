import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/statement`,
  summary:
    "The app's statement for one UTC month, what the forge would charge (docs/PROFIT.md): lines { what, quantity, unit, price, amount } for awake time, storage, crew spend at cost and the margin on it, and a total, in US dollars rounded once to the cent; month defaults to this one; format=csv (or accept: text/csv) gives the same lines as CSV; for the repository's admins and forge admins, anyone else a 404; needs a token",
  auth: true,
  role: "member",
  query: { month: "string", format: "string" },
  reply: {
    app: "string",
    month: "string",
    from: "string",
    to: "string",
    currency: "string",
    marginPct: "number",
    lines: "array",
    total: "number",
  },
  refusals: {
    bad_month: "month is not YYYY-MM from 2000-01 (422)",
    invalid_format: "format is not json or csv (422)",
  },
};
