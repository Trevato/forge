import { afterEach, expect, test } from "bun:test";
import {
  noteProtection,
  protectionNotice,
  resetProtection,
} from "../src/kernel/protection.ts";

afterEach(resetProtection);

test("a fully protected forge has no notice", () => {
  noteProtection("apps", { ok: true });
  expect(protectionNotice()).toBeUndefined();
});

test("a part that lacks protection is named with its reason, in one line", () => {
  noteProtection("apps", { ok: false, reason: "bwrap is not installed" });
  noteProtection("crew shells", { ok: false, reason: "no sandbox on win32" });
  const line = protectionNotice()!;
  expect(line).toContain("apps (bwrap is not installed)");
  expect(line).toContain("crew shells (no sandbox on win32)");
  expect(line).not.toContain("\n");
});

test("a part that recovers clears its own line", () => {
  noteProtection("apps", { ok: false, reason: "x" });
  noteProtection("apps", { ok: true });
  expect(protectionNotice()).toBeUndefined();
});
