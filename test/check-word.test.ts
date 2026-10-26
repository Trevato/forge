import { expect, test } from "bun:test";
import { checkWord } from "../src/apps/check_word.ts";

const run = (state: "queued" | "running" | "ok" | "failed" | "cancelled", commitOid = "h1") => ({
  state,
  commitOid,
});

test("an ok run of the head is green", () => expect(checkWord(run("ok"), "h1")).toBe("green"));
test("a failed run of the head is red", () => expect(checkWord(run("failed"), "h1")).toBe("red"));
test("queued and running are running", () => {
  expect(checkWord(run("queued"), "h1")).toBe("running");
  expect(checkWord(run("running"), "h1")).toBe("running");
});
test("a cancelled run is none", () => expect(checkWord(run("cancelled"), "h1")).toBe("none"));
test("no run is none", () => expect(checkWord(undefined, "h1")).toBe("none"));
test("a run of an older head is none, whatever its state", () => {
  for (const s of ["queued", "running", "ok", "failed", "cancelled"] as const)
    expect(checkWord(run(s, "old"), "h1")).toBe("none");
});
