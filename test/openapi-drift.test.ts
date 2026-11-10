import { expect, test } from "bun:test";
import { openapi, ROUTES } from "../src/contract/openapi.ts";
import { norm, registered } from "./helpers/registered_routes.ts";

/**
 * The OpenAPI description and the router's public REST routes agree. Each
 * route on one side only fails the test by name. Left out on purpose, with why:
 */
const NOT_ROUTED: Readonly<Record<string, string>> = {
  "GET /contract/openapi.json": "the document, an alias of /api/v1/openapi.json served outside /api/v1",
  "GET /api/v1/repos/{}/{}/app/production/open": "the described form of the routed /app/:env/open, with env fixed to production",
  "GET /metrics": "routed outside /api/v1 (src/http/api.ts); the scan reads /api/v1 routes only",
  "POST /mcp": "routed outside /api/v1 (src/http/mcp.ts); the MCP has its own card and tool list",
};
const NOT_DESCRIBED: Readonly<Record<string, string>> = {};

const key = (method: string, path: string) => `${method.toUpperCase()} ${norm(path)}`;

test("no public REST route is missing from the description, and none described is unrouted", () => {
  const described = new Set(ROUTES.map((r) => key(r.method, r.path)));
  const routed = new Set(registered());
  const onlyRouter = [...routed].filter((r) => !described.has(r) && !(r in NOT_DESCRIBED)).map((r) => `${r}  (routed, not described)`);
  const onlyDoc = [...described].filter((r) => !routed.has(r) && !(r in NOT_ROUTED)).map((r) => `${r}  (described, not routed)`);
  expect([...onlyRouter, ...onlyDoc].sort(), "routes on one side only").toEqual([]);
});

test("every deliberate exclusion still has a reason and is still true", () => {
  const described = new Set(ROUTES.map((r) => key(r.method, r.path)));
  const routed = new Set(registered());
  for (const [r, why] of [...Object.entries(NOT_ROUTED), ...Object.entries(NOT_DESCRIBED)]) expect(why.trim().length).toBeGreaterThan(0), r;
  expect(Object.keys(NOT_ROUTED).filter((r) => routed.has(r) || !described.has(r))).toEqual([]);
  expect(Object.keys(NOT_DESCRIBED).filter((r) => described.has(r) || !routed.has(r))).toEqual([]);
});

/**
 * Pinned by hand from the handlers' own guards (`boardsAdmin`, `accountAdmin`,
 * `isAdmin`, the /api/v1/admin gate): the routes only a site admin may call
 * outside /api/v1/admin/*, and a few routes whose role is easy to misread.
 */
const PINNED: Readonly<Record<string, "anonymous" | "member" | "admin">> = {
  "GET /api/v1": "anonymous",
  "GET /api/v1/openapi.json": "anonymous",
  "GET /api/v1/health": "anonymous",
  "GET /api/v1/front": "anonymous",
  "PUT /api/v1/front": "admin",
  "GET /api/v1/boards": "admin",
  "PUT /api/v1/boards/{slug}": "admin",
  "POST /api/v1/boards/query": "admin",
  "GET /api/v1/cloud/accounts": "admin",
  "GET /api/v1/crew/week": "admin",
  "GET /api/v1/crew/scorecard": "admin",
  "GET /api/v1/forges": "admin",
  "PUT /api/v1/forges/{name}/credit": "admin",
  "POST /api/v1/forges/{name}/claim-link": "admin",
  "POST /api/v1/drills": "admin",
  "PUT /api/v1/forge/economics": "admin",
  "GET /metrics": "admin",
  "GET /api/v1/admin/limits": "admin",
  "PUT /api/v1/admin/shield": "admin",
  // An admin scope token is not a site admin: a repository's own admin may call these.
  "POST /api/v1/repos/{owner}/{name}/hooks": "member",
  "PATCH /api/v1/repos/{owner}/{name}": "member",
  "PUT /api/v1/user/notify": "member",
  "GET /api/v1/user/origins": "member",
  "GET /api/v1/repos/{owner}/{name}/issues": "anonymous",
  // A session or the password, never a token: still a signed-in caller. Signing out needs neither.
  "DELETE /api/v1/tokens/{id}": "member",
  "POST /api/v1/tokens": "member",
  "DELETE /api/v1/sessions": "anonymous",
};

test("every operation names its role, as the pinned list says", () => {
  const doc = openapi("https://x.test", "0") as { paths: Record<string, Record<string, { "x-role": string }>> };
  const byKey = new Map(ROUTES.map((r) => [`${r.method.toUpperCase()} ${r.path.replace(/\{owner\}\/\{name\}/, "{owner}/{name}")}`, r]));
  for (const [k, role] of Object.entries(PINNED)) {
    const r = byKey.get(k);
    expect(r, `${k} is not a described route`).toBeDefined();
    expect(doc.paths[r!.path]![r!.method]!["x-role"], k).toBe(role);
  }
});

/**
 * The routes that need a signed-in account but refuse a bearer token: a browser
 * session or the password, never a token (`auth` false, role `member`). Pinned
 * from the handlers in src/http/api/tokens.ts, src/http/api.ts and src/http/api/conversation_confirms.ts.
 * `DELETE /api/v1/sessions` is not here: without a session it answers 200 all the same.
 */
const SESSION_ONLY: ReadonlySet<string> = new Set([
  "GET /api/v1/tokens",
  "POST /api/v1/tokens",
  "DELETE /api/v1/tokens/{}",
  "POST /api/v1/conversation-tokens",
  "POST /api/v1/conversation-confirms/{}",
]);

test("an anonymous route takes no token, a token route is never anonymous, and every /admin route is admin only", () => {
  for (const r of ROUTES) {
    const k = key(r.method, r.path);
    if (r.role === "anonymous") expect(r.auth, k).toBe(false);
    else expect(r.auth, k).toBe(!SESSION_ONLY.has(k));
    if (r.path.startsWith("/api/v1/admin/")) expect(r.role, k).toBe("admin");
  }
  for (const k of SESSION_ONLY) {
    const r = ROUTES.find((x) => key(x.method, x.path) === k);
    expect(r, `${k} is not a described route`).toBeDefined();
    expect(r!.role, k).toBe("member");
  }
  expect(new Set(ROUTES.map((r) => r.role))).toEqual(new Set(["anonymous", "member", "admin"]));
});
