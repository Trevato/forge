import { expect, test } from "bun:test";
import { checkStale } from "../src/checks/stale.ts";
import { checksLine } from "../src/web/pages/pull.ts";

test("the base moved after a green: stale", () => {
  expect(checkStale({ baseOid: "aaa" }, "bbb")).toBe(true);
});

test("a check on the current tip is not stale", () => {
  expect(checkStale({ baseOid: "bbb" }, "bbb")).toBe(false);
});

test("an empty base_oid, no run, or an unreadable base is not stale", () => {
  expect(checkStale({ baseOid: "" }, "bbb")).toBe(false);
  expect(checkStale(null, "bbb")).toBe(false);
  expect(checkStale({ baseOid: "aaa" }, undefined)).toBe(false);
});

test("the pull page says so in place of green", () => {
  const ok = { state: "ok", run: null } as const;
  const stale = checksLine("/a/b", ok, false, true, false, "", "", 0, "main", true).text;
  expect(stale).toContain("Checked against an older main");
  expect(stale).not.toContain('class="ok"');
  expect(checksLine("/a/b", ok, false, true, false, "", "", 0, "main", false).text).toContain("Check passed");
});

test("the terminal says the green is against an older main", async () => {
  const { checksText } = await import("../src/tui/screens/pull.ts");
  const seen = { state: "ok", run: null } as const;
  expect(checksText(seen, false, true, "main", true)).toBe("checks: passed against an older main");
  expect(checksText(seen, false, true, "main", false)).toBe("checks: passed");
});
