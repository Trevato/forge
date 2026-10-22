/** The OpenAPI document describes the forge's admin settings routes. */
import { expect, test } from "bun:test";
import { ROUTES } from "../src/contract/openapi.ts";

const WANTED: readonly [string, string][] = [
  ["get", "/api/v1/admin/settings"],
  ["patch", "/api/v1/admin/settings"],
  ["get", "/api/v1/admin/limits"],
  ["get", "/api/v1/admin/capacity"],
  ["get", "/api/v1/admin/teams"],
  ["get", "/api/v1/admin/people"],
];

test("each admin settings path and method is in the document", () => {
  for (const [method, path] of WANTED)
    expect(ROUTES.some((r) => r.method === method && r.path === path && r.auth)).toBe(true);
});
