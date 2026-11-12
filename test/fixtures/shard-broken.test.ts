// Fixture for test/shards-run.test.ts, kept out of the gate: fails alone too.
import { expect, test } from "bun:test";

test("broken", () => {
  expect(1).toBe(2);
});
