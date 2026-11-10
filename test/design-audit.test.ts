/**
 * docs/design/audit.md has one entry for every top-level page, and names no
 * route the router does not have (#2709). The router is read as text: the
 * static GET paths in src/http/server.ts and settings_routes.ts, less the
 * ones that are not pages.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The settings routes register from their own module (#8309), so both are read.
const server = ["src/http/server.ts", "src/http/settings_routes.ts"]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const doc = readFileSync("docs/design/audit.md", "utf8");

/** Routes that answer a file, a fragment, a redirect hop or a callback. */
const NOT_PAGES =
  /^\/(assets\/|\.well-known\/|icons\/|og\/|live\/|__forge\/|go\/|new\/issue$|events$|system\/stream$|talk\/stream$|settings\/teams\/stream$|sw\.js$|robots\.txt$|favicon\.ico$|apple-touch-icon(-precomposed)?\.png$|sitemap\.xml$|manifest\.webmanifest$|opensearch\.xml$|llms\.txt$|openapi\.json$|releases\.json$|changelog\.atom$|docs(\/[^/]*)?$|audit\.csv$|settings\/traffic\/scrapes\/export$|fleet\/graph\/live$|fleet\/graph\.csv$|settings\/origins\/callback$|home\/archived\/|settings\/backups\/live$|api\/v1(\/|$))/;

const getRoutes = [
  ...server.matchAll(/router\.add\(\s*"GET",\s*"([^"]+)"/g),
].map((m) => m[1]!);

const pages = [
  ...new Set(
    getRoutes.filter((r) => !/[:*]/.test(r) && !NOT_PAGES.test(r)),
  ),
];

const entries = [...doc.matchAll(/^- `(\/[^`]*)`/gm)].map((m) => m[1]!);

test("every top-level page has an entry in the audit", () => {
  expect(entries.length).toBe(pages.length);
  expect(pages.filter((p) => !entries.includes(p))).toEqual([]);
});

test("the audit names no route that does not exist", () => {
  const known = new Set(getRoutes);
  const named = [...doc.matchAll(/`(\/[a-z0-9\-/._:]*)`/g)].map((m) => m[1]!);
  const ghosts = named.filter(
    (r) =>
      !known.has(r) &&
      // a path inside a repository, a file, or a prefix, not a route
      !/^\/(:owner|\.|src|docs)/.test(r) &&
      !/^\/(llms\.txt|tokens\.css)/.test(r),
  );
  expect(ghosts).toEqual([]);
  expect(entries.filter((e) => !known.has(e))).toEqual([]);
});

test("each entry is written once", () => {
  expect(entries.length).toBe(new Set(entries).size);
});

test("each operator view states why it is a page (#2696)", () => {
  const section = doc.split("## Operator views")[1]?.split("\n## ")[0] ?? "";
  for (const r of ["/audit", "/waves", "/variants/", "/following", "/board/returns", "/looks/"])
    expect(section).toContain(r);
});
