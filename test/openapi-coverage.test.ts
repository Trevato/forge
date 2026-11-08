import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { ROUTES } from "../src/contract/openapi.ts";

/**
 * Every `/api/v1` route registered in src/http/api.ts has a row in `ROUTES`
 * (one file each under src/contract/openapi/routes/), or is listed here. This list only shrinks: describe
 * a route, then delete its line: an entry that is now described fails the test
 * until you do.
 */
const NOT_YET_DESCRIBED: readonly string[] = [
];

const norm = (path: string) => path.replace(/[:*]\w+/g, "{}").replace(/\{\w+\}/g, "{}");

/** Every file under src/http (and its route modules in src/http/api/) that registers routes. */
const files = () =>
  [...readdirSync(new URL("../src/http/", import.meta.url)), ...readdirSync(new URL("../src/http/api/", import.meta.url)).map((f) => `api/${f}`)]
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
