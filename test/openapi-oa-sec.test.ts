/** The OpenAPI document describes secrets, tokens, sessions and telemetry. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const WANT: readonly (readonly [string, string])[] = [
  ["/api/v1/secrets/{scope}", "get"],
  ["/api/v1/secrets/{scope}/{name}", "delete"],
  ["/api/v1/tokens", "get"],
  ["/api/v1/tokens", "post"],
  ["/api/v1/tokens/{id}", "delete"],
  ["/api/v1/sessions", "post"],
  ["/api/v1/sessions", "delete"],
  ["/api/v1/telemetry/system", "get"],
  ["/api/v1/telemetry/flow", "get"],
  ["/api/v1/telemetry/sources", "get"],
  ["/api/v1/telemetry/history", "get"],
];

test("each secrets, token, session and telemetry route is in the document", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const [path, method] of WANT) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
});

test("token routes say a bearer token is refused, secrets that no value is read back", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const [p, m] of [["/api/v1/tokens", "get"], ["/api/v1/tokens", "post"], ["/api/v1/tokens/{id}", "delete"]] as const)
    expect(doc.paths[p][m].summary).toContain("bearer token is refused");
  expect(doc.paths["/api/v1/secrets/{scope}"].get.summary).toContain("never a value");
  expect(doc.paths["/api/v1/secrets/{scope}/{name}"].delete.summary).toContain("never read back");
});
