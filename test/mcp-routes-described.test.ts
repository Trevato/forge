/**
 * The forge's own OpenAPI description is `contract/openapi.ts` (served at
 * `/contract/openapi.json`; `/api` reads it). Every REST route an MCP tool's
 * doc names ("as `GET /api/v1/user/pins` is") must be in it, so an agent that
 * reads the description finds what the tools use.
 */
import { expect, test } from "bun:test";
import { ROUTES } from "../src/contract/openapi.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

const shape = (path: string): string => path.replace(/\{\w+\}|:\w+/g, "{}");

const described = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${shape(r.path)}`));

/** `[tool, "METHOD /path"]` for each route a tool's text names, `PUT`/`DELETE /x` naming both. */
function named(): [string, string][] {
  const found: [string, string][] = [];
  for (const tool of TOOLS) {
    const text = `${tool.doc} ${tool.description}`;
    for (const m of text.matchAll(/((?:\b[A-Z]{3,6}\b[`\/ ]*){1,4})`?\s*(\/api\/v1\/[^\s`,;)]*)/g)) {
      const path = shape(m[2]!.replace(/[.:]+$/, ""));
      for (const method of m[1]!.match(/[A-Z]{3,6}/g)!) found.push([tool.name, `${method} ${path}`]);
    }
  }
  return found;
}

test("the walk finds the routes the tools name", () => {
  expect(named().length).toBeGreaterThan(20);
});

test("every REST route an MCP tool names is in the published OpenAPI description", () => {
  const missing = named().filter(([, route]) => !described.has(route));
  expect(missing.map(([tool, route]) => `${route} (named by the ${tool} tool)`)).toEqual([]);
});
