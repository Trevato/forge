/** The builds list joins the shell's j/k row traversal, as the bets list does: one data-nav per pin row, none on the empty page. */
import { expect, test } from "bun:test";
import { buildsList } from "../src/web/pages/builds.ts";
import type { BuildNode } from "../src/core/lineage.ts";

const node = (label: string, depth = 0) =>
  ({
    pin: { label, oid: "a".repeat(40), note: label, source: "commit", pinnedBy: "dev", pinnedAt: 0 },
    depth,
    edge: "git",
  }) as unknown as BuildNode;
const NAV = /class="row"[^>]*data-nav tabindex="-1"/;

test("the empty builds page draws no data-nav row", () => {
  const out = buildsList("/dev/lib", [], true).toString();
  expect(out).toContain("No builds yet.");
  expect(out).not.toMatch(NAV);
});

test("each pin is one data-nav row whose first link opens its commit", () => {
  const out = buildsList("/dev/lib", [node("v1"), node("v2", 1), node("v3", 1)], false).toString();
  const rows = out.split("<li").filter((li) => NAV.test(li));
  expect(rows.length).toBe(3);
  expect(rows[0]!.match(/<a [^>]*href="([^"]+)"/)![1]).toBe(`/dev/lib/commit/${"a".repeat(40)}`);
});
