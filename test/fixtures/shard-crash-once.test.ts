// On its first run this file leaves a timer that throws after its test,
// while its `afterAll` still holds the process. bun reports that as an
// unhandled error between tests, like "Cannot use a closed database" from
// a leaked timer. Its second run is green: `SHARD_CRASH_MARK` names the
// file that remembers the first. scripts/test-shards.ts re-runs such a
// shard once (#7788).
import { existsSync, writeFileSync } from "node:fs";
import { afterAll, test } from "bun:test";

const mark = process.env["SHARD_CRASH_MARK"];
const first = mark !== undefined && !existsSync(mark);
if (first) writeFileSync(mark!, "");

test("leaves a timer behind on its first run", () => {
  if (first)
    setTimeout(() => {
      throw new Error("Cannot use a closed database");
    }, 0);
});

afterAll(async () => {
  await Bun.sleep(30);
});
