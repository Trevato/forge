/** The OpenAPI document describes the milestones list as a page: { items, next_cursor }. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

test("GET milestones summary names the page shape, not { repo, limbs }", () => {
  const doc = openapi("https://f.test", "1") as any;
  const op = doc.paths["/api/v1/repos/{owner}/{name}/milestones"]?.get;
  expect(op).toBeDefined();
  expect(op.summary).toContain("{ items, next_cursor }");
  expect(op.summary).toContain("limit 1–200");
  expect(op.summary).not.toContain("limbs }");
});
