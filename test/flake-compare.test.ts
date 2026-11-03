/**
 * `scripts/flake-compare.ts` (#9045): one night of the forge's flake hunt
 * and outside gate beside the Forgejo job's, read from their logs.
 */

import { describe, expect, test } from "bun:test";
import { compareNights, readNight, report } from "../scripts/flake-compare.ts";

const outside = `$ bun scripts/flake-hunt.ts outside --file-issues
green: test/a.test.ts
red  : test/b.test.ts
  filed #12 for test/b.test.ts
green: test/c.test.ts
  closed #7 for test/c.test.ts
3 files outside the gate, 1 red`;

const hunt = `hunt run 1/5: seed 42, 3 files
  red: test/d.test.ts (seed 42)
red in every run (broken, not flaky): test/e.test.ts
FLAKY test/d.test.ts: red 1, green 4; first red seed 42
  filed #30
quarantined test/d.test.ts (#30)
pushed flake-hunt/2026-11-03`;

/** A Forgejo step log: each line behind a timestamp. */
const stamped = (log: string) =>
  log
    .split("\n")
    .map((line) => `2026-11-03T02:17:00.0000000Z ${line}`)
    .join("\n");

describe("flake-compare", () => {
  test("reads what a night filed", () => {
    const night = readNight([outside, hunt]);
    expect([...night.outside]).toEqual([
      ["test/a.test.ts", "green"],
      ["test/b.test.ts", "red"],
      ["test/c.test.ts", "green"],
    ]);
    expect(night.red.get("test/b.test.ts")).toEqual({ kind: "filed", issue: 12 });
    expect(night.red.get("test/c.test.ts")).toEqual({ kind: "closed", issue: 7 });
    expect([...night.flaky]).toEqual([["test/d.test.ts", 30]]);
    expect([...night.broken]).toEqual(["test/e.test.ts"]);
    expect([...night.quarantined]).toEqual([["test/d.test.ts", 30]]);
    expect(night.pull).toBe("flake-hunt/2026-11-03");
  });

  test("the same night on both sides has no differences, timestamps or not", () => {
    const { text, agree } = report(readNight([outside, hunt]), readNight([stamped(hunt), stamped(outside)]));
    expect(agree).toBe(true);
    expect(text).toContain("no differences");
  });

  test("one side finding the other's Red: issue already open is agreement", () => {
    const silent = outside.replace("  filed #12 for test/b.test.ts\n", "");
    expect(compareNights(readNight([outside]), readNight([silent]))).toEqual([]);
  });

  test("a test filed by only one side is named", () => {
    const forgeHunt = hunt.replace("  filed #30", "  filed #30\nFLAKY test/f.test.ts: red 2, green 3; first red seed 9\n  filed #31");
    const diffs = compareNights(readNight([outside, forgeHunt]), readNight([outside, hunt]));
    expect(diffs).toEqual(["Flaky: test/f.test.ts: only forge found it (#31)"]);
  });

  test("a file red on one side and green on the other is named, as is a missing pull", () => {
    const forgejoOutside = outside.replace("red  : test/b.test.ts\n  filed #12 for test/b.test.ts", "green: test/b.test.ts");
    const forgejoHunt = hunt.replace("quarantined test/d.test.ts (#30)\npushed flake-hunt/2026-11-03", "nothing to quarantine");
    const { text, agree } = report(readNight([outside, hunt]), readNight([forgejoOutside, forgejoHunt]));
    expect(agree).toBe(false);
    expect(text).toContain("outside test/b.test.ts: red on forge, green on forgejo");
    expect(text).toContain("quarantined test/d.test.ts: only forge moved it");
    expect(text).toContain("quarantine pull: only forge proposed one");
  });
});
