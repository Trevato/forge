// Fixture for test/shards-run.test.ts, kept out of the gate: sets a global that
// shard-victim.test.ts cannot stand beside. Both pass alone.
import { test } from "bun:test";

(globalThis as Record<string, unknown>)["__shardPoison"] = true;
test("poison passes", () => {});
