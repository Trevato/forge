import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/data/{env}/{file}/tables`,
  summary: "The tables of one database with their row counts: { items: [{ name, rows }] }; a database you may not read is a 404; needs a token",
  auth: true,
};
