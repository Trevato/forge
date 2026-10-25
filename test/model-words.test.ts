/**
 * Adding a model subscription and refusing an amount are said from one
 * place, `src/actions/model_words.ts`, so the web page and the terminal
 * screens read the same. Each file that says them is read as text: a copy
 * of the sentence typed back into it fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AMOUNT_REFUSED, SUBSCRIPTION_ADDED } from "../src/actions/model_words.ts";

const root = join(import.meta.dir, "..");
const source = (path: string): string => readFileSync(join(root, path), "utf8");

const SAYERS: Record<string, readonly string[]> = {
  "src/web/pages/model.ts": ["SUBSCRIPTION_ADDED"],
  "src/tui/screens/model.ts": ["SUBSCRIPTION_ADDED", "AMOUNT_REFUSED"],
  "src/tui/screens/people.ts": ["AMOUNT_REFUSED"],
};

describe("the model and people sentences", () => {
  test("are the words they always were", () => {
    expect(SUBSCRIPTION_ADDED).toBe("Your subscription is added, for your own repositories.");
    expect(AMOUNT_REFUSED).toBe("That amount will not do.");
  });

  for (const [path, names] of Object.entries(SAYERS)) {
    test(`${path} imports them and types no copy`, () => {
      const text = source(path);
      expect(text).toContain('from "../../actions/model_words.ts"');
      for (const name of names) expect(text).toContain(name);
      expect(text).not.toContain(SUBSCRIPTION_ADDED);
      expect(text).not.toContain(AMOUNT_REFUSED);
    });
  }
});
