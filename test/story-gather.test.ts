import { expect, test } from "bun:test";
import { gather, plainTitle, standsAlone } from "../src/story/gather.ts";
import type { Landing } from "../src/release/landings.ts";
import { shippedRegion } from "../src/web/pages/changelog.ts";

const pages = ["issues", "pulls", "apps", "crew", "runs", "forks", "people", "notes", "tells"];
const keys = (page: string) => `small: j/k, enter, esc and ? on ${page}, with test/keys-${page}.test.ts`;
const land = (n: number, title: string, extra: Partial<Landing> = {}): Landing => ({
  repo: "a/forge", number: n, title, at: `2026-11-10T0${n % 10}:00:00.000Z`, live: true, by: "Scout", with: ["Claude Sonnet 5.5"], ...extra,
});

test("titles drop the lane and test or source paths", () => {
  // A first word with a non-letter (keys like j/k) is written as it is said; a plain word gets its capital.
  expect(plainTitle(keys("pulls"))).toBe("j/k, enter, esc and ? on pulls");
  expect(plainTitle("small: fold the copy")).toBe("Fold the copy");
  expect(plainTitle("small: Fold the copy in src/web/ui.ts")).toBe("Fold the copy");
  expect(plainTitle("Add a thing")).toBe("Add a thing");
});

test("the nine keys pulls gather into one line, credited once", () => {
  const day = pages.map((p, i) => land(i + 1, keys(p)));
  const lines = gather(day);
  expect(lines).toHaveLength(1);
  expect(lines[0]!.landings).toHaveLength(9);
  expect(lines[0]!.shape).toBe("j/k, enter, esc and ? on …");
  expect(lines[0]!.by).toEqual(["Scout"]);
});

test("unlike titles stay single; reverts and security fixes stay on their own line", () => {
  const day = [
    land(1, "Revert: j/k, enter, esc and ? on pulls"),
    land(2, "j/k, enter, esc and ? on issues"),
    land(3, "j/k, enter, esc and ? on apps"),
    land(4, "Security: j/k, enter, esc and ? on crew"),
    land(5, "Something else entirely"),
  ];
  expect(standsAlone(day[0]!.title)).toBe(true);
  expect(gather(day).map((g) => g.landings.map((l) => l.number))).toEqual([[1], [2, 3], [4], [5]]);
});

test("the page folds a gathered line in place, with the author said once", () => {
  const live = pages.map((p, i) => land(i + 1, keys(p)));
  const out = shippedRegion({ version: "v", commit: null, own: "a/forge", live, onItsWay: [] }, "a/forge").toString();
  expect(out).toContain("<details");
  expect(out).toContain("9 pulls");
  expect(out.match(/Scout/g)?.length).toBe(1);
  expect(out).not.toContain("small:");
});
