import { describe, expect, test } from "bun:test";
import { tellNumberOf } from "../src/web/studio/branch_tell.ts";

describe("tellNumberOf", () => {
  test("reads the number out of <crew>/<number>-<slug>", () => {
    expect(tellNumberOf("scout/13-after-new-app-land")).toBe(13);
    expect(tellNumberOf("mason/4-update-from-parent")).toBe(4);
  });
  test("a slug containing digits does not change the number", () => {
    expect(tellNumberOf("scout/13-fix-404-on-2fa")).toBe(13);
  });
  test("anything else is no tell", () => {
    for (const b of [
      "main",
      "revert-22",
      "feature/door-test",
      "scout/no-number",
      "scout/13",
      "scout/0-zero",
      "scout/013-padded",
      "scout/99999999999999999-huge",
      "/13-x",
      "",
    ])
      expect(tellNumberOf(b)).toBeUndefined();
  });
});
