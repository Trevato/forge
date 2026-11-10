/** A pull's checks are in the served OpenAPI document. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const P = "/api/v1/repos/{owner}/{name}/pulls/{number}/checks";

test("GET and POST …/pulls/{number}/checks are described", () => {
  const paths = openapi("http://x", "1").paths as Record<string, Record<string, any>>;
  expect(paths[P]?.get?.summary).toContain("checks");
  expect(paths[P]?.post?.responses?.["202"]).toBeDefined();
  expect(paths[P]?.get?.security).toEqual([]);
  expect(paths[P]?.post?.security).toEqual([{ token: [] }, { oauth2: ["rw"] }]);
  const ok = (m: string, code: string) =>
    paths[P]?.[m]?.responses?.[code]?.content?.["application/json"]?.schema?.properties;
  expect(Object.keys(ok("get", "200"))).toEqual(["head", "state", "required", "run", "runs"]);
  expect(Object.keys(ok("post", "202"))).toEqual(["run"]);
  expect(JSON.stringify(paths[P]?.post)).toContain("no_check_declared");
});
