import { expect, test } from "bun:test";
import { limbHref, milestoneHref } from "../src/web/pages/milestones.ts";

test("milestoneHref is the base, /milestones/, and the number", () => {
  expect(milestoneHref("/a/b", 7)).toBe("/a/b/milestones/7");
});

test("limbHref names the action, and `under` only when given", () => {
  expect(limbHref("/a/b", 7, "defer")).toBe("/a/b/milestones/7/limb?action=defer");
  expect(limbHref("/a/b", 7, "raise", "top")).toBe(
    "/a/b/milestones/7/limb?action=raise&under=top",
  );
});

test("limbHref encodes `under` so & and # cannot cut the link", () => {
  const href = limbHref("/a/b", 7, "lower", "x&y#z");
  expect(href).toBe("/a/b/milestones/7/limb?action=lower&under=x%26y%23z");
  const q = new URL(href, "http://x").searchParams;
  expect(q.get("under")).toBe("x&y#z");
  expect(q.get("action")).toBe("lower");
});
