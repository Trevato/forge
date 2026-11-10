import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { failedWith, machineNote } from "./helpers/machine-note.ts";

test("a heavy test's failure names the disk's free share and the load, not a bare timeout (#10541)", () => {
  expect(machineNote(tmpdir())).toMatch(/^disk \d+% free under .+; load \d+\.\d on \d+ cores$/);
  expect(machineNote("/no/such/dir")).toStartWith("disk unknown; load ");
  const message = failedWith("the child forge did not come up in its cell", { failure: "its cell did not come up: no output" }, "x".repeat(3000) + "tail");
  expect(message).toContain("its cell did not come up: no output");
  expect(message).toContain("% free under");
  expect(message.endsWith("tail")).toBe(true);
  expect(message.length).toBeLessThan(2000);
});
