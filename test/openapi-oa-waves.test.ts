/** The OpenAPI document describes a repository's waves: the list and one wave. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}";

test("the waves list and one wave are in the served document with their 404", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const list = doc.paths[`${R}/waves`]?.get;
  const one = doc.paths[`${R}/waves/{version}`]?.get;
  expect(list).toBeDefined();
  expect(one).toBeDefined();
  expect(list.security).toEqual([]);
  expect(one.security).toEqual([]);
  expect(list.responses.default.description).toContain("`not_found`");
  expect(one.responses.default.description).toContain("no such wave");
});

// The query parameters a handler reads are the ones the description lists (#11335).
import { readFileSync } from "node:fs";

/** The source from `start` to the next top-level route or function, cut by marker. */
function slice(file: string, start: string, end: string): string {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const from = src.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = src.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return src.slice(from, to);
}

/** Every name the code reads off the query string, however the URL is reached. */
const reads = (code: string): string[] =>
  [...new Set([...code.matchAll(/searchParams\s*\.\s*(?:get|getAll|has)\(\s*["'](\w+)["']/g)].map((m) => m[1]!))].sort();

const described = (path: string): string[] => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  const params: any[] = doc.paths[path]?.get?.parameters ?? [];
  return params.filter((p) => p.in === "query").map((p) => p.name as string).sort();
};

test("GET /api/v1/changelog lists each query parameter its handler reads", () => {
  const code = slice("src/web/pages/changelog.ts", "export async function changelogJson", "\n}\n");
  expect(reads(code)).toEqual(["repo"]);
  expect(described("/api/v1/changelog")).toEqual(reads(code));
  const doc = openapi("https://f.test", "1", "admin") as any;
  const repo = doc.paths["/api/v1/changelog"].get.parameters.find((p: any) => p.name === "repo");
  expect(repo.schema.type).toBe("string");
});

test("the waves list lists each query parameter its handler reads", () => {
  const code = slice("src/http/api.ts", '"/api/v1/repos/:owner/:name/waves", async', '"/api/v1/repos/:owner/:name/waves/:version"');
  expect(described(`${R}/waves`)).toEqual(reads(code));
});

test("the comparison fails on a parameter the description lacks", () => {
  expect(reads('ctx.url.searchParams.get("limit")')).toEqual(["limit"]);
  expect(described("/api/v1/changelog")).not.toEqual(reads('ctx.url.searchParams.get("repo"); ctx.url.searchParams.get("limit")'));
});
