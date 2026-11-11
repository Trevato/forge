/** The OpenAPI document describes watching a milestone: PUT and DELETE …/milestones/{number}/watch. */
import { expect, test } from "bun:test";
import { openapi } from "../src/contract/openapi.ts";

const PATH = "/api/v1/repos/{owner}/{name}/milestones/{number}/watch";

test("PUT and DELETE watch each have a row with the refusals the handler answers", () => {
  const doc = openapi("https://f.test", "1", "admin") as any;
  for (const m of ["put", "delete"]) {
    const op = doc.paths[PATH]?.[m];
    expect(op, m).toBeDefined();
    const text = JSON.stringify(op);
    for (const code of ["unauthorized", "forbidden", "not_found"]) expect(text, `${m} ${code}`).toContain(`\`${code}\``);
    expect(op.summary).toContain("{ watching }");
  }
});
