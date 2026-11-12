/** Each explore row says in a phrase why it ranks where it does (#11296). */
import { expect, test } from "bun:test";
import { whyOf, type ExploreRow } from "../src/actions/explore.ts";

const why = (...a: Parameters<typeof whyOf>): string => whyOf(...a)?.text ?? "";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const row = (n: Partial<ExploreRow["numbers"]>, shippedAt: string | null = null): ExploreRow => ({
  kind: "app", name: "a/b", url: "/a/b", description: "", shippedAt, score: 0,
  numbers: { forks: 0, ships: 0, likes: 0, awakeHours: 0, apps: 1, ...n },
});

test("a row with the most forks says forks", () => {
  expect(why(row({ forks: 12 }, "2026-10-01T00:00:00Z"), "score", NOW)).toBe("12 forks");
  expect(why(row({ forks: 1 }), "forks", NOW)).toBe("1 fork");
});

test("a fresh row says shipped", () => {
  expect(why(row({}, "2026-11-11T08:00:00Z"), "score", NOW)).toBe("shipped today");
  expect(why(row({}, "2026-11-08T08:00:00Z"), "fresh", NOW)).toBe("shipped 3 days ago");
});

test("a named sort says its own signal; shipped says times this month", () => {
  expect(why(row({ forks: 5, ships: 3 }), "ships", NOW)).toBe("3 shipped this month");
  expect(why(row({ likes: 2 }), "likes", NOW)).toBe("2 likes");
  expect(why(row({}), "score", NOW)).toBe("");
});

test("the default sort weighs as the ranking does: the forge's weights, and forks win a tie", () => {
  const tied = { forks: 1, ships: 1, use: 0, fresh: 0 };
  expect(why(row({ forks: 1, ships: 1 }), "score", NOW, tied)).toBe("1 fork");
  // Other weights, other reason: the same row is told by what the forge counts most.
  expect(why(row({ forks: 1, ships: 1 }), "score", NOW, { ...tied, ships: 5 })).toBe("1 shipped this month");
  // Forks beat ships and freshness at the defaults.
  expect(why(row({ forks: 2, ships: 1 }, "2026-11-11T08:00:00Z"), "score", NOW)).toBe("2 forks");
});

test("a row shipped in the future reads as shipped today, never a negative count", () => {
  expect(why(row({}, "2026-11-20T00:00:00Z"), "fresh", NOW)).toBe("shipped today");
  expect(why(row({}, "2026-11-20T00:00:00Z"), "score", NOW)).toBe("shipped today");
});

test("the signal a phrase says is named, so beside it the row does not say it again", () => {
  expect(whyOf(row({ forks: 3, likes: 1 }), "score", NOW)?.signal).toBe("forks");
  expect(whyOf(row({}, "2026-11-11T08:00:00Z"), "fresh", NOW)?.signal).toBe("fresh");
  expect(whyOf(row({}), "score", NOW)).toBeUndefined();
});
