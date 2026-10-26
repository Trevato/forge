/**
 * "Report a problem (no account needed)" is said in one place (#5624):
 * src/actions/report_words.ts. The proxy, the API and the standards pages
 * read it from there; a copy typed back into one of them fails here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_LINK_TITLE } from "../src/actions/report_words.ts";

const SENTENCES = ["Report a problem (no account needed)"];
const READERS = ["src/apps/proxy.ts", "src/http/api.ts", "src/web/standards.ts"];
const source = (path: string) =>
  readFileSync(join(import.meta.dir, "..", path), "utf8");

test("the module says the sentence", () => {
  expect(REPORT_LINK_TITLE).toBe("Report a problem (no account needed)");
});

for (const path of READERS)
  test(`${path} imports the words and types none of them`, () => {
    const text = source(path);
    expect(text).toContain("../actions/report_words.ts");
    for (const sentence of SENTENCES) expect(text).not.toContain(sentence);
  });
