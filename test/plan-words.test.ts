/**
 * The planner's refusals are said from one place (#5595): each sentence
 * `actions/plan_words.ts` exports is non-empty, and no file that says it
 * types its own copy back in.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IN_HAND, SELF_WAIT } from "../src/actions/plan_words.ts";

const READERS = [
  "src/actions/dependencies.ts",
  "src/actions/plan.ts",
  "src/actions/limb_replan.ts",
  "src/tui/screens/limbs.ts",
  "src/contract/openapi/routes/postApiV1ReposOwnerNameIssuesNumberDependencies.ts",
];

const source = (path: string) =>
  readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("the planner's words", () => {
  for (const [name, words] of Object.entries({ SELF_WAIT, IN_HAND })) {
    test(`${name} says something`, () => {
      expect(words.trim().length).toBeGreaterThan(0);
    });

    for (const path of READERS)
      test(`${path} does not type ${name} out again`, () => {
        expect(source(path)).not.toContain(words);
      });
  }
});
