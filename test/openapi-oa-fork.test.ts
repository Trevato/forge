/** The fork tree is in the served OpenAPI document. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}";
const WANT: readonly [string, string][] = [
  ["get", `${R}/following`],
  ["get", `${R}/following/proposals`],
  ["post", `${R}/following/converge`],
  ["post", `${R}/following/propose`],
  ["post", `${R}/following/propose-parent`],
  ["post", `${R}/following/sever`],
  ["post", `${R}/following/take`],
  ["patch", "/api/v1/forge/following"],
  ["get", `${R}/upstream`],
  ["post", `${R}/upstream/check`],
  ["post", `${R}/sync`],
  ["post", `${R}/make-it-yours`],
  ["post", `${R}/origin/reconnect`],
  ["get", `${R}/forks`],
  ["get", `${R}/tags`],
  ["get", "/api/v1/family"],
];

test("each fork-tree path and method is in the document", () => {
  const paths = openapi("http://x", "1", "admin").paths as Record<string, Record<string, unknown>>;
  for (const [method, path] of WANT) expect(paths[path]?.[method]).toBeDefined();
});
