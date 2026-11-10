/** A pull's review threads are in the served OpenAPI document. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const T = "/api/v1/repos/{owner}/{name}/pulls/{number}/threads";

test("list, resolve and reopen are described", () => {
  const paths = openapi("http://x", "1").paths as Record<string, Record<string, any>>;
  expect(paths[T]?.get).toBeDefined();
  expect(paths[T]?.get.security).toEqual([]);
  expect(paths[`${T}/{anchor}/resolve`]?.post).toBeDefined();
  expect(paths[`${T}/{anchor}/resolve`]?.delete).toBeDefined();
  expect(paths[`${T}/{anchor}/resolve`]?.post.security).toBeDefined();
});

test("resolve and reopen state their refusals with the statuses the handler answers", () => {
  const paths = openapi("http://x", "1").paths as Record<string, Record<string, any>>;
  for (const method of ["post", "delete"]) {
    const text: string = paths[`${T}/{anchor}/resolve`]![method].responses.default.description;
    expect(text).toContain("`not_found` (the pull has no thread at `anchor` (404))");
    expect(text).toContain("`forbidden` (you neither wrote the thread's comments nor can write to the repository (403))");
    expect(text).not.toContain("422");
  }
});
