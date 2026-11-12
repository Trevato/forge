import { expect, test } from "bun:test";
import { ROUTES } from "../src/contract/openapi.ts";
import { norm, registered } from "./helpers/registered_routes.ts";

/**
 * Every `/api/v1` route registered in src/http/api.ts has a row in `ROUTES`
 * (one file each under src/contract/openapi/routes/), or is listed here. This list only shrinks: describe
 * a route, then delete its line: an entry that is now described fails the test
 * until you do.
 */
const NOT_YET_DESCRIBED: readonly string[] = [
];

test("every registered /api/v1 route has an OpenAPI row or is listed as not yet described", () => {
  const described = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${norm(r.path)}`));
  const all = registered();
  const missing = all.filter((r) => !described.has(r) && !NOT_YET_DESCRIBED.includes(r));
  expect(missing, `routes with no OpenAPI row (add a file under src/contract/openapi/routes/, then run bun scripts/openapi-routes.ts):\n${missing.join("\n")}`).toEqual([]);
});

test("NOT_YET_DESCRIBED has no entry that is now described", () => {
  const described = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${norm(r.path)}`));
  const stale = NOT_YET_DESCRIBED.filter((r) => described.has(r));
  expect(stale, `described now; delete these lines from NOT_YET_DESCRIBED:\n${stale.join("\n")}`).toEqual([]);
});

test("NOT_YET_DESCRIBED is sorted and names registered routes", () => {
  expect([...NOT_YET_DESCRIBED]).toEqual([...NOT_YET_DESCRIBED].sort());
  const all = new Set(registered());
  expect(NOT_YET_DESCRIBED.filter((r) => !all.has(r))).toEqual([]);
});

test("every registered /api/v1 route has a row with a summary an agent can read", () => {
  const rows = new Map(ROUTES.map((r) => [`${r.method.toUpperCase()} ${norm(r.path)}`, r.summary]));
  const bare = registered().filter((r) => !NOT_YET_DESCRIBED.includes(r) && (rows.get(r) ?? "").trim().length < 10);
  expect(bare, `routes whose OpenAPI summary is empty or a stub:\n${bare.join("\n")}`).toEqual([]);
});
