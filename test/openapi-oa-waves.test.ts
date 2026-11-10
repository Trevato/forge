/** The OpenAPI document describes a repository's waves: the list and one wave. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}";

test("the waves list and one wave are in the served document with their 404", () => {
  const doc = openapi("https://f.test", "1") as any;
  const list = doc.paths[`${R}/waves`]?.get;
  const one = doc.paths[`${R}/waves/{version}`]?.get;
  expect(list).toBeDefined();
  expect(one).toBeDefined();
  expect(list.security).toEqual([]);
  expect(one.security).toEqual([]);
  expect(list.responses.default.description).toContain("`not_found`");
  expect(one.responses.default.description).toContain("no such wave");
});
