import { expect, test } from "bun:test";
import type { ProviderError } from "../src/origins/types.ts";
import { toSourceError } from "../src/view/origin.ts";

// Keyed by the type: adding a ProviderError without deciding its word fails tsc.
const WORDS: Record<ProviderError, ReturnType<typeof toSourceError>> = {
  not_found: "not_found",
  rate_limited: "rate_limited",
  unauthorized: "unauthorized",
  forbidden: "unauthorized",
  unreachable: "unreachable",
  invalid_response: "unreachable",
};

test("toSourceError gives every provider failure its word", () => {
  for (const [error, word] of Object.entries(WORDS)) {
    expect(toSourceError({ error: error as ProviderError, message: "x" })).toBe(word);
  }
});

test("toSourceError reads an unknown failure as unreachable", () => {
  expect(toSourceError({ error: "teapot" as ProviderError, message: "x" })).toBe("unreachable");
});
