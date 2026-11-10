import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/data/{env}/{file}/query`,
  summary:
    "Run one read-only SELECT or WITH on a database (read-only connection, 5 s, at most 1,000 rows, secret columns masked): { columns, rows, truncated }; reads only, so a read-scope token suffices; needs a token",
  auth: true,
  body: { sql: "string" },
  refusals: {
    invalid_sql: "sql is not one SELECT or WITH statement, or SQLite refused it (422)",
    timeout: "the query ran past 5 seconds (422)",
    busy: "other queries are running; try again (429)",
  },
};
