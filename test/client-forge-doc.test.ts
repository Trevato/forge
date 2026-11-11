import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownPatterns } from "../src/http/server.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";

const path = join(import.meta.dir, "..", "docs/features/client-forge.md");
const doc = readFileSync(path, "utf8");

const routes = [...new Set([...doc.matchAll(/`(\/[^`\s]*)`/g)].map((m) => m[1]!))];
const tools = [...new Set([...doc.matchAll(/MCP tool\s+`([a-z_]+)`/g)].map((m) => m[1]!))];

test("the page stays under 60 lines", () => {
  expect(doc.trimEnd().split("\n").length).toBeLessThan(60);
});

test("the page names routes and tools to follow", () => {
  expect(routes.length).toBeGreaterThan(5);
  expect(tools.length).toBeGreaterThan(3);
});

test("every route the page names is in the router", () => {
  const known = new Set(knownPatterns());
  for (const r of routes) expect(known.has(r), `route ${r}`).toBe(true);
});

test("every MCP tool the page names is in the tool list", () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const t of tools) expect(names.has(t), `tool ${t}`).toBe(true);
});

test("a step with no door says so in one line", () => {
  expect(doc).toContain("No door yet:");
});
