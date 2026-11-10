/** The OpenAPI document describes agents, org writes and the crew's doors. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const REPO = "/api/v1/repos/{owner}/{name}";
const want: readonly (readonly [string, string])[] = [
  ["post", "/api/v1/agents"],
  ["get", "/api/v1/agents/{username}"],
  ["patch", "/api/v1/agents/{username}"],
  ["delete", "/api/v1/agents/{username}"],
  ["post", "/api/v1/orgs"],
  ["post", "/api/v1/orgs/{org}/teams"],
  ["delete", "/api/v1/orgs/{org}/teams/{team}"],
  ["post", "/api/v1/orgs/{org}/teams/{team}/members"],
  ["delete", "/api/v1/orgs/{org}/teams/{team}/members/{username}"],
  ["get", "/api/v1/openapi.json"],
  ["get", "/metrics"],
  ["get", "/api/v1/contribute"],
  ["post", `${REPO}/contribute`],
  ["post", `${REPO}/edits`],
  ["post", "/api/v1/thoughts"],
  ["get", "/api/v1/asked"],
  ["get", "/api/v1/returns"],
  ["get", "/api/v1/here"],
  ["get", "/api/v1/crew/scorecard"],
];

test("each agent and crew door is in the served document", () => {
  const doc = openapi("https://f.test", "1") as any;
  for (const [method, path] of want) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
  expect(doc.paths["/api/v1/thoughts"].post.security).toBeDefined();
  expect(doc.paths["/api/v1/here"].get.security).toEqual([]);
});
