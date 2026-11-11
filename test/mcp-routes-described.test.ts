/**
 * The forge's own OpenAPI description is `contract/openapi.ts` (served at
 * `/contract/openapi.json`; `/api` reads it). Every REST route an MCP tool's
 * doc names ("as `GET /api/v1/user/pins` is") must be in it, so an agent that
 * reads the description finds what the tools use. A tool also writes a route
 * short, `PATCH …/issues/:number`: the tail must be whole trailing segments of a
 * described path of that method, and a tail that fits several paths is reported
 * as ambiguous unless SHORT_MEANS says which path the tool means, or exactly one
 * fit lies under `/api/v1/repos/` (what a bare `…/` means in the tools).
 *
 * That last rule is a convenience with a known gap: when the one repos fit is not
 * the path the tool meant (it meant an origins or user path, and the repos path
 * only shares its tail), the test still passes. A tail whose meaning is not the
 * repository's goes in SHORT_MEANS, where the test holds it to the paths named.
 *
 * MCP_ONLY is the table of routes deliberately left out of the description, each
 * with its reason. Both tables are checked for stale entries: a key no tool names
 * any more, an MCP-only route that is now described, a SHORT_MEANS tail that no
 * longer fits several paths, each fails until the line is deleted.
 */
import { expect, test } from "bun:test";
import { ROUTES } from "../src/contract/openapi.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

const shape = (path: string): string => path.replace(/\{\w+\}|:\w+/g, "{}");

type Table<T> = Readonly<Record<string, T>>;

/** "METHOD /path" or "METHOD …/tail" a tool names → why the OpenAPI description deliberately leaves it out. */
const MCP_ONLY: Table<string> = {};

/** A short route that fits several paths → the paths it means (each must be described). */
const SHORT_MEANS: Table<readonly string[]> = {
  "POST …/{}/sync": ["/api/v1/user/origins/{}/sync"],
  // `assign` sets the assignee of an issue or of a pull.
  "PUT …/assignee": ["/api/v1/repos/{}/{}/issues/{}/assignee", "/api/v1/repos/{}/{}/pulls/{}/assignee"],
};

interface Row {
  readonly method: string;
  readonly path: string;
}
interface Doc {
  readonly name: string;
  readonly doc?: string;
  readonly description: string;
}

/** `[tool, "METHOD /path"]` for each full route a tool's text names, `PUT`/`DELETE /x` naming both. */
function named(tools: readonly Doc[]): [string, string][] {
  const found: [string, string][] = [];
  for (const tool of tools) {
    const text = `${tool.doc ?? ""} ${tool.description}`;
    for (const m of text.matchAll(/((?:\b[A-Z]{3,6}\b[`\/ ]*){1,4})`?\s*(\/api\/v1\/[^\s`,;)]*)/g)) {
      const path = shape(m[2]!.replace(/[.:]+$/, ""));
      for (const method of m[1]!.match(/[A-Z]{3,6}/g)!) found.push([tool.name, `${method} ${path}`]);
    }
  }
  return found;
}

/** `[tool, method, "/tail"]` for each short route (`METHOD …/tail`) a tool's text names. */
function namedShort(tools: readonly Doc[]): [string, string, string][] {
  const found: [string, string, string][] = [];
  for (const tool of tools) {
    const text = `${tool.doc ?? ""} ${tool.description}`;
    for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s*`?…(\/[A-Za-z0-9_/:{}-]+)/g)) {
      found.push([tool.name, m[1]!, shape(m[2]!)]);
    }
  }
  return found;
}

/**
 * Each route the tools name that the rows do not list, as a line saying so.
 * `mcpOnly` maps "METHOD /path" (or "METHOD …/tail") to why it is deliberately
 * not described; `shortMeans` maps "METHOD …/tail" to the paths it means. A short
 * tail that fits more than one described path, and neither table nor the repos
 * rule settles, is reported as ambiguous.
 */
function missingRoutes(
  tools: readonly Doc[],
  rows: readonly Row[],
  mcpOnly: Table<string> = {},
  shortMeans: Table<readonly string[]> = {},
): string[] {
  const shaped = rows.map((r) => ({ method: r.method.toUpperCase(), path: shape(r.path) }));
  const have = new Set(shaped.map((r) => `${r.method} ${r.path}`));
  const out: string[] = [];
  for (const [tool, route] of named(tools)) {
    if (!have.has(route) && mcpOnly[route] === undefined) out.push(`${route} (named by the ${tool} tool)`);
  }
  for (const [tool, method, tail] of namedShort(tools)) {
    if (mcpOnly[`${method} …${tail}`] !== undefined) continue;
    const fits = shaped.filter((r) => r.method === method && r.path.length > tail.length && r.path.endsWith(tail));
    if (fits.length === 0) out.push(`${method} …${tail} (named by the ${tool} tool)`);
    else if (fits.length > 1) {
      const meant = shortMeans[`${method} …${tail}`];
      if (meant !== undefined) {
        for (const path of meant)
          if (!fits.some((r) => r.path === path)) out.push(`${method} …${tail} means ${path}, which is not described (named by the ${tool} tool)`);
        continue;
      }
      if (fits.filter((r) => r.path.startsWith("/api/v1/repos/")).length === 1) continue;
      out.push(`${method} …${tail} is ambiguous: it fits ${fits.map((r) => r.path).join(", ")} (named by the ${tool} tool)`);
    }
  }
  return out;
}

/** Each entry in either table that no longer earns its line, as a line saying why. */
function staleEntries(
  tools: readonly Doc[],
  rows: readonly Row[],
  mcpOnly: Table<string>,
  shortMeans: Table<readonly string[]>,
): string[] {
  const shaped = rows.map((r) => ({ method: r.method.toUpperCase(), path: shape(r.path) }));
  const said = new Set([
    ...named(tools).map(([, route]) => route),
    ...namedShort(tools).map(([, method, tail]) => `${method} …${tail}`),
  ]);
  const fits = (key: string): number => {
    const [method, rest] = key.split(" ", 2) as [string, string];
    const tail = rest.replace(/^…/, "");
    return shaped.filter((r) =>
      r.method === method && (rest.startsWith("…") ? r.path.length > tail.length && r.path.endsWith(tail) : r.path === tail),
    ).length;
  };
  const out: string[] = [];
  for (const [key, why] of Object.entries(mcpOnly)) {
    if (!said.has(key)) out.push(`MCP_ONLY ${key}: no tool names it`);
    if (why.trim().length === 0) out.push(`MCP_ONLY ${key}: no reason`);
    if (fits(key) > 0) out.push(`MCP_ONLY ${key}: the description lists it now`);
  }
  for (const [key, paths] of Object.entries(shortMeans)) {
    if (!said.has(key)) out.push(`SHORT_MEANS ${key}: no tool names it`);
    if (fits(key) < 2) out.push(`SHORT_MEANS ${key}: it fits one path or none, so it is not ambiguous`);
    if (paths.length === 0) out.push(`SHORT_MEANS ${key}: names no path`);
  }
  return out;
}

const FIXTURE_ROWS: Row[] = [
  { method: "get", path: "/api/v1/repos/{owner}/{name}/issues/{number}" },
  { method: "post", path: "/api/v1/repos/{owner}/{name}/sync" },
  { method: "post", path: "/api/v1/user/origins/{id}/sync" },
  { method: "post", path: "/api/v1/repos/{owner}/{name}/pulls/{number}/sync" },
  { method: "get", path: "/api/v1/user/pins" },
];
const tool = (doc: string): Doc => ({ name: "t", doc, description: "" });

test("the walk finds the routes the tools name", () => {
  expect(named(TOOLS).length).toBeGreaterThan(20);
  expect(namedShort(TOOLS).length).toBeGreaterThan(10);
});

test("every REST route an MCP tool names is in the published OpenAPI description", () => {
  expect(missingRoutes(TOOLS, ROUTES, MCP_ONLY, SHORT_MEANS)).toEqual([]);
});

test("MCP_ONLY and SHORT_MEANS hold no stale entry", () => {
  expect(staleEntries(TOOLS, ROUTES, MCP_ONLY, SHORT_MEANS)).toEqual([]);
});

test("a stale table entry is reported", () => {
  const tools = [tool("`GET /api/v1/user/hidden` and `POST …/sync`")];
  expect(staleEntries(tools, FIXTURE_ROWS, { "GET /api/v1/user/hidden": "only an agent asks for it" }, {})).toEqual([]);
  expect(staleEntries(tools, FIXTURE_ROWS, { "GET /api/v1/user/gone": "a reason" }, {})).toEqual([
    "MCP_ONLY GET /api/v1/user/gone: no tool names it",
  ]);
  expect(staleEntries(tools, FIXTURE_ROWS, { "GET /api/v1/user/hidden": " " }, {})).toEqual(["MCP_ONLY GET /api/v1/user/hidden: no reason"]);
  const described = [tool("`GET /api/v1/user/pins`")];
  expect(staleEntries(described, FIXTURE_ROWS, { "GET /api/v1/user/pins": "was MCP-only once" }, {})).toEqual([
    "MCP_ONLY GET /api/v1/user/pins: the description lists it now",
  ]);
  expect(staleEntries(tools, FIXTURE_ROWS, {}, { "POST …/sync": ["/api/v1/user/origins/{}/sync"] })).toEqual([]);
  expect(staleEntries(tools, FIXTURE_ROWS, {}, { "POST …/gone": ["/api/v1/x"] })).toEqual([
    "SHORT_MEANS POST …/gone: no tool names it",
    "SHORT_MEANS POST …/gone: it fits one path or none, so it is not ambiguous",
  ]);
});

test("a full route absent from the rows is reported, and listed MCP-only it is not", () => {
  const t = [tool("as `GET /api/v1/user/nope` is")];
  expect(missingRoutes(t, FIXTURE_ROWS)).toEqual(["GET /api/v1/user/nope (named by the t tool)"]);
  expect(missingRoutes(t, FIXTURE_ROWS, { "GET /api/v1/user/nope": "only the MCP reads it" })).toEqual([]);
  expect(missingRoutes([tool("as `GET /api/v1/user/pins` is")], FIXTURE_ROWS)).toEqual([]);
});

test("a short route is matched on whole trailing segments", () => {
  expect(missingRoutes([tool("`GET …/issues/:number`")], FIXTURE_ROWS)).toEqual([]);
  // "/sues/{}" ends the path's text but not at a segment boundary.
  expect(missingRoutes([tool("`GET …/sues/:number`")], FIXTURE_ROWS)).toEqual(["GET …/sues/{} (named by the t tool)"]);
  // The wrong method does not count.
  expect(missingRoutes([tool("`PUT …/issues/:number`")], FIXTURE_ROWS)).toEqual(["PUT …/issues/{} (named by the t tool)"]);
  expect(missingRoutes([tool("`GET …/gone`")], FIXTURE_ROWS, { "GET …/gone": "MCP-only: no page asks" })).toEqual([]);
});

test("a short route fitting several paths resolves to the repo one, or to SHORT_MEANS, or is ambiguous", () => {
  const rows: Row[] = [...FIXTURE_ROWS, { method: "get", path: "/api/v1/user/origins/{id}/issues/{number}" }];
  expect(missingRoutes([tool("`GET …/issues/:number`")], rows)).toEqual([]);
  const many: Row[] = [...rows, { method: "get", path: "/api/v1/repos/{o}/{n}/x/issues/{number}" }];
  expect(missingRoutes([tool("`GET …/issues/:number`")], many)[0]).toContain("is ambiguous");
  const means = { "POST …/{}/sync": ["/api/v1/user/origins/{}/sync"] };
  expect(missingRoutes([tool("`POST …/:id/sync`")], FIXTURE_ROWS, {}, means)).toEqual([]);
  const noOrigins = FIXTURE_ROWS.filter((r) => !r.path.includes("/origins/"));
  expect(missingRoutes([tool("`POST …/:id/sync`")], noOrigins, {}, means)[0]).toContain("which is not described");
  expect(missingRoutes([tool("`POST …/sync`")], FIXTURE_ROWS)[0]).toContain("is ambiguous");
});
