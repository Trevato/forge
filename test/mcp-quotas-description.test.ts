import { expect, test } from "bun:test";
import { QUOTA_KEYS } from "../src/settings/quotas.ts";
import { tool } from "../src/http/mcp/tools/quotas.ts";

test("the quotas tool says quotas are enforced and names every key", () => {
  expect(tool.description).not.toContain("unenforced");
  for (const key of QUOTA_KEYS) {
    expect(tool.description).toContain(key);
    expect(tool.doc).toContain(`\`${key}\``);
  }
  expect(tool.description).toContain("admin");
  expect(tool.doc).toContain("forge admin is never limited");
});
