/**
 * The quota and usage admin sentences live in one module (#5621): the web
 * pages and the terminal screens import them, and none types its own copy.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUOTA_INVALID, USAGE_ADMIN_ONLY } from "../src/actions/admin_limits_words.ts";

const root = join(import.meta.dir, "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");

const readers: Record<string, { name: string; sentence: string }> = {
  "src/web/pages/admin-limits.ts": { name: "QUOTA_INVALID", sentence: QUOTA_INVALID },
  "src/tui/screens/quotas.ts": { name: "QUOTA_INVALID", sentence: QUOTA_INVALID },
  "src/web/pages/usage.ts": { name: "USAGE_ADMIN_ONLY", sentence: USAGE_ADMIN_ONLY },
  "src/tui/screens/usage.ts": { name: "USAGE_ADMIN_ONLY", sentence: USAGE_ADMIN_ONLY },
};

test("the sentences read as they always have", () => {
  expect(QUOTA_INVALID).toBe("A quota is a positive whole number, or empty for no limit.");
  expect(USAGE_ADMIN_ONLY).toBe("Usage is read by a forge admin.");
});

for (const [file, { name, sentence }] of Object.entries(readers)) {
  test(`${file} imports ${name} and types no copy of it`, () => {
    const text = read(file);
    expect(text).not.toContain(sentence);
    expect(text).toContain(`${name} } from "../../actions/admin_limits_words.ts"`);
  });
}
