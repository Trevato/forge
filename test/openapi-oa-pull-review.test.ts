/** A pull's review states and attaching a look are in the served OpenAPI document. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}/pulls/{number}";
type Op = { security?: unknown; responses?: Record<string, unknown>; requestBody?: unknown };

test("review-states and looks are described with their method, auth and refusals", () => {
  const paths = openapi("http://x", "1").paths as Record<string, Record<string, Op>>;
  expect(paths[`${R}/review-states`]?.get).toBeDefined();
  const post = paths[`${R}/review-states`]?.post;
  expect(post?.requestBody).toBeDefined();
  expect(post?.responses?.["201"]).toBeDefined();
  expect(JSON.stringify(post)).toContain("self_review");
  const look = paths[`${R}/looks`]?.post;
  expect(look?.requestBody).toBeDefined();
  expect(look?.responses?.["201"]).toBeDefined();
  expect(JSON.stringify(look)).toContain("not_open");
  expect(paths[`${R}/looks`]?.get).toBeDefined();
});
