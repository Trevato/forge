// Fixture for test/shards-run.test.ts, kept out of the gate: fails only in a
// process where shard-poison.test.ts has already run.
import { expect, test } from "bun:test";

test("victim", () => {
  expect((globalThis as Record<string, unknown>)["__shardPoison"]).toBeUndefined();
});
