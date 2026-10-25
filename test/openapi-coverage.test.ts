import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ROUTES } from "../src/contract/openapi.ts";

/**
 * Every `/api/v1` route registered in src/http/api.ts has a row in `ROUTES`
 * (src/contract/openapi.ts), or is listed here. This list only shrinks: describe
 * a route, then delete its line. An entry that is now described is ignored.
 */
const NOT_YET_DESCRIBED: readonly string[] = [
  "DELETE /api/v1/boards/{}",
  "DELETE /api/v1/orgs/{}/teams/{}/members/{}",
  "DELETE /api/v1/repos/{}/{}",
  "DELETE /api/v1/repos/{}/{}/branches/{}",
  "DELETE /api/v1/repos/{}/{}/labels/{}",
  "DELETE /api/v1/repos/{}/{}/pulls/{}/hold",
  "DELETE /api/v1/user/keys/{}",
  "DELETE /api/v1/user/origin-apps/{}",
  "DELETE /api/v1/user/origins/{}",
  "DELETE /api/v1/user/pins/{}/{}",
  "GET /api/v1/agents",
  "GET /api/v1/asks",
  "GET /api/v1/boards",
  "GET /api/v1/boards/pins",
  "GET /api/v1/boards/sources",
  "GET /api/v1/boards/{}",
  "GET /api/v1/boards/{}/panels/{}",
  "GET /api/v1/feed",
  "GET /api/v1/feed/chips",
  "GET /api/v1/migrate/{}/stream",
  "GET /api/v1/openapi.json",
  "GET /api/v1/orgs/{}",
  "GET /api/v1/orgs/{}/teams",
  "GET /api/v1/orgs/{}/teams/{}/members",
  "GET /api/v1/repos/{}/{}/app/{}/open",
  "GET /api/v1/repos/{}/{}/branches",
  "GET /api/v1/repos/{}/{}/commits",
  "GET /api/v1/repos/{}/{}/commits/{}",
  "GET /api/v1/repos/{}/{}/commits/{}/check",
  "GET /api/v1/repos/{}/{}/contents",
  "GET /api/v1/repos/{}/{}/contents/{}",
  "GET /api/v1/repos/{}/{}/issues/{}/dependencies",
  "GET /api/v1/repos/{}/{}/issues/{}/teams",
  "GET /api/v1/repos/{}/{}/labels",
  "GET /api/v1/repos/{}/{}/milestones",
  "GET /api/v1/repos/{}/{}/milestones/{}",
  "GET /api/v1/repos/{}/{}/pulls/{}/review-states",
  "GET /api/v1/repos/{}/{}/pulls/{}/reviews",
  "GET /api/v1/repos/{}/{}/reports",
  "GET /api/v1/user",
  "GET /api/v1/user/assigned",
  "GET /api/v1/user/keys",
  "GET /api/v1/user/orgs",
  "GET /api/v1/user/origin-apps",
  "GET /api/v1/user/origins",
  "GET /api/v1/user/origins/oauth/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/blob/{}/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/branches",
  "GET /api/v1/user/origins/{}/browse/{}/{}/commits",
  "GET /api/v1/user/origins/{}/browse/{}/{}/commits/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/issues",
  "GET /api/v1/user/origins/{}/browse/{}/{}/issues/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/labels",
  "GET /api/v1/user/origins/{}/browse/{}/{}/paths/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/pulls",
  "GET /api/v1/user/origins/{}/browse/{}/{}/pulls/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/tags",
  "GET /api/v1/user/origins/{}/browse/{}/{}/tree/{}",
  "GET /api/v1/user/origins/{}/browse/{}/{}/tree/{}/{}",
  "GET /api/v1/user/origins/{}/mirror/{}",
  "GET /api/v1/user/origins/{}/mirror/{}/stream",
  "GET /api/v1/user/origins/{}/repos",
  "GET /api/v1/user/pins",
  "GET /api/v1/users/{}",
  "GET /api/v1/users/{}/repos",
  "PATCH /api/v1/repos/{}/{}/pulls/{}",
  "PATCH /api/v1/user",
  "POST /api/v1/asks/bulk",
  "POST /api/v1/asks/bulk/{}/undo",
  "POST /api/v1/asks/decide",
  "POST /api/v1/asks/decide/{}/undo",
  "POST /api/v1/asks/proposal/{}/{}",
  "POST /api/v1/boards/pins",
  "POST /api/v1/boards/query",
  "POST /api/v1/feed/chips",
  "POST /api/v1/feed/interactions",
  "POST /api/v1/repos",
  "POST /api/v1/repos/{}/{}/branches",
  "POST /api/v1/repos/{}/{}/contents",
  "POST /api/v1/repos/{}/{}/issues/{}/dependencies/{}/confirm",
  "POST /api/v1/repos/{}/{}/issues/{}/private",
  "POST /api/v1/repos/{}/{}/labels",
  "POST /api/v1/repos/{}/{}/milestones/{}/limb",
  "POST /api/v1/repos/{}/{}/prompts/{}/run",
  "POST /api/v1/repos/{}/{}/proposal-tokens",
  "POST /api/v1/repos/{}/{}/pulls/{}/approve-here",
  "POST /api/v1/repos/{}/{}/pulls/{}/comments",
  "POST /api/v1/repos/{}/{}/pulls/{}/looks",
  "POST /api/v1/repos/{}/{}/pulls/{}/review-states",
  "POST /api/v1/repos/{}/{}/pulls/{}/variant",
  "POST /api/v1/repos/{}/{}/reports/{}/accept",
  "POST /api/v1/repos/{}/{}/reports/{}/dismiss",
  "POST /api/v1/repos/{}/{}/runs/{}/steer",
  "POST /api/v1/share",
  "POST /api/v1/user/keys",
  "POST /api/v1/user/origin-apps",
  "POST /api/v1/user/origins",
  "POST /api/v1/user/origins/oauth",
  "POST /api/v1/user/origins/{}/browse/{}/{}/contribute",
  "POST /api/v1/user/origins/{}/fork",
  "POST /api/v1/user/origins/{}/mirror",
  "POST /api/v1/user/origins/{}/sync",
  "PUT /api/v1/admin/capacity/{}",
  "PUT /api/v1/admin/limits/{}",
  "PUT /api/v1/admin/teams/{}",
  "PUT /api/v1/boards/{}",
  "PUT /api/v1/front",
  "PUT /api/v1/repos/{}/{}/crew/{}",
  "PUT /api/v1/repos/{}/{}/issues/{}/assignee",
  "PUT /api/v1/repos/{}/{}/issues/{}/labels",
  "PUT /api/v1/repos/{}/{}/issues/{}/teams",
  "PUT /api/v1/repos/{}/{}/pulls/{}/assignee",
  "PUT /api/v1/repos/{}/{}/pulls/{}/hold",
  "PUT /api/v1/repos/{}/{}/pulls/{}/labels",
  "PUT /api/v1/repos/{}/{}/upstream",
  "PUT /api/v1/secrets/{}/{}",
  "PUT /api/v1/user/pins/{}/{}",
];

const norm = (path: string) => path.replace(/[:*]\w+/g, "{}").replace(/\{\w+\}/g, "{}");

/** Every file under src/http that registers routes. */
const files = () =>
  readdirSync(new URL("../src/http/", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, src: readFileSync(new URL(`../src/http/${f}`, import.meta.url), "utf8") }))
    .filter(({ src }) => src.includes("router.add("));

/**
 * The /api/v1 routes registered, as "METHOD /api/v1/…" with params as `{}`.
 * A path may be a string, a template literal or a constant of the same file
 * (`BROWSE`); `${NAME}` is resolved, and `${kind}` is the loop over issues and pulls. A `router.add` call this cannot read as
 * "METHOD", path throws, so a changed call style cannot shrink coverage.
 */
const registered = (): string[] => {
  const found = new Set<string>();
  for (const { f, src } of files()) {
    const consts = new Map([...src.matchAll(/\bconst ([A-Z_]+) = "([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    const resolve = (p: string) => p.replace(/\$\{([A-Z_]+)\}/g, (_, n) => consts.get(n) ?? `\${${n}}`);
    let read = 0;
    for (const m of src.matchAll(/router\.add\(\s*(?:"([A-Z]+)"|(method)),\s*(?:"([^"]*)"|`([^`]*)`|([A-Z_]+)\b)/g)) {
      read++;
      const path = resolve(m[3] ?? m[4] ?? consts.get(m[5]!) ?? "");
      if (!path.startsWith("/api/v1")) {
        if (!path.startsWith("/") && !m[3]) throw new Error(`${f}: router.add path not resolvable: ${JSON.stringify(path)} in ${JSON.stringify(m[0])}`);
        continue;
      }
      if (path.replace("${kind}", "").includes("${")) throw new Error(`${f}: router.add path not resolvable: ${JSON.stringify(path)} in ${JSON.stringify(m[0])}`);
      for (const method of m[1] ? [m[1]] : ["PUT", "DELETE"]) // `method` is the PUT/DELETE loop
        for (const v of path.includes("${kind}") ? ["issues", "pulls"] : [""]) found.add(`${method} ${norm(path.replace("${kind}", v))}`);
    }
    const calls = src.split("router.add(").length - 1;
    if (read !== calls) throw new Error(`${f}: ${calls} router.add calls but only ${read} readable`);
  }
  return [...found].sort();
};

test("every registered /api/v1 route has an OpenAPI row or is listed as not yet described", () => {
  const described = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${norm(r.path)}`));
  const all = registered();
  const missing = all.filter((r) => !described.has(r) && !NOT_YET_DESCRIBED.includes(r));
  const removable = NOT_YET_DESCRIBED.filter((r) => described.has(r));
  console.log(`openapi-coverage: ${removable.length} NOT_YET_DESCRIBED entries could be removed`);
  expect(missing, `routes with no OpenAPI row (add one to ROUTES in src/contract/openapi.ts):\n${missing.join("\n")}`).toEqual([]);
});

test("NOT_YET_DESCRIBED is sorted and names registered routes", () => {
  expect([...NOT_YET_DESCRIBED]).toEqual([...NOT_YET_DESCRIBED].sort());
  const all = new Set(registered());
  expect(NOT_YET_DESCRIBED.filter((r) => !all.has(r))).toEqual([]);
});
