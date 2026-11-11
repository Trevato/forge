import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/data/{env}/{file}/rows`,
  summary:
    "One page of 50 rows of a table: { columns, page, total, rows }; secret columns (token, secret, password, hash, key, cookie, …) show ••••••; no such table is a 404; needs a token",
  auth: true,
  role: "member",
  query: { table: "string", page: { type: "integer", min: 0, max: 1000 } },
  refusals: {
    invalid_table: "table is missing (422)",
    invalid_page: "page is not a whole number from 0 (422)",
  },
};
