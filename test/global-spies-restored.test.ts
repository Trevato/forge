/**
 * A spy on a global (`Date`, `globalThis`, `Math`, `performance`, `process`)
 * outlives its file: `bun test` runs a shard's files in one process, so every
 * later file reads the spy — a `Date.now` frozen by one file made
 * `setSystemTime` move nothing in nine tests elsewhere in its shard (#9498).
 * A file that spies on one restores it (`mock.restore()` or `.mockRestore()`).
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL(".", import.meta.url).pathname;
const SPY = /spyOn\(\s*(Date|globalThis|Math|performance|process)\b/;
const RESTORE = /mock\.restore\(\)|\.mockRestore\(\)/;

/** The test files that spy on a global and never restore it. */
export function unrestored(files: ReadonlyArray<{ name: string; text: string }>): string[] {
  return files.filter((f) => SPY.test(f.text) && !RESTORE.test(f.text)).map((f) => f.name);
}

test("a spy on a global without a restore is named; one with a restore is not", () => {
  const spied = 'beforeAll(() => { spyOn(Date, "now").mockImplementation(() => 1); });';
  expect(unrestored([{ name: "a.test.ts", text: spied }])).toEqual(["a.test.ts"]);
  expect(unrestored([{ name: "b.test.ts", text: `${spied} afterAll(() => mock.restore());` }])).toEqual([]);
  expect(unrestored([{ name: "c.test.ts", text: 'spyOn(app, "send")' }])).toEqual([]);
});

test("every test file that spies on a global restores it", () => {
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") && name !== "global-spies-restored.test.ts")
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  expect(unrestored(files)).toEqual([]);
});
