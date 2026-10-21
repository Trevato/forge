import { describe, expect, test } from "bun:test";
import { MAX_PER_PUBLIC_DESTINATION } from "../src/apps/egress.ts";

// #3719 capped every destination at 8 and stopped every check's package install at the registry (2026-10-21).
describe("egress connection caps", () => {
  test("a public host allows an install's parallel fetches", () => {
    expect(MAX_PER_PUBLIC_DESTINATION).toBeGreaterThanOrEqual(48);
  });
});
