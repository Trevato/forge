import { expect, test } from "bun:test";
import { retryStep } from "./helpers/chrome.ts";

test("a step that fails until the element appears is retried until it runs", async () => {
  let calls = 0;
  await retryStep(async () => (++calls < 4 ? "no such element" : undefined), Date.now() + 2_000, 1);
  expect(calls).toBe(4);
});

test("a step that never succeeds throws its last failure at the deadline", async () => {
  await expect(retryStep(async () => "no such element", Date.now() + 50, 5)).rejects.toThrow(
    "step never ran: no such element",
  );
});
