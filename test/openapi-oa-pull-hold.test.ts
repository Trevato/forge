/** The OpenAPI document describes a pull's labels and hold. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const R = "/api/v1/repos/{owner}/{name}/pulls/{number}";

test("a pull's labels and hold have rows, with the refusals the handlers answer", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  expect(doc.paths[`${R}/labels`]?.put, "put labels").toBeDefined();
  const put = doc.paths[`${R}/hold`]?.put;
  const del = doc.paths[`${R}/hold`]?.delete;
  expect(put, "put hold").toBeDefined();
  expect(del, "delete hold").toBeDefined();
  const text = JSON.stringify(put);
  for (const [code, status] of [["forbidden", 403], ["not_open", 409], ["empty_why", 422], ["why_too_long", 422]] as const)
    expect(text, code).toMatch(new RegExp(`\`${code}\`[^}]*\\(${status}\\)`));
  expect(JSON.stringify(del)).toMatch(/`forbidden`[^}]*\(403\)/);
  expect(put.summary).toContain("never an agent");
  expect(del.summary).toContain("never an agent");
  const schema = put.requestBody.content["application/json"].schema;
  expect(schema.properties.why.type).toBe("string");
});
